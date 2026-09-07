import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

const REPO = path.resolve(import.meta.dirname, '../..')

async function waitFor(predicate, { attempts = 200, delay = 25, message = 'condition' } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, delay))
  }
  throw new Error(`timed out waiting for ${message}`)
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const count = (text, re) => (text.match(re) || []).length

describe('Room autonomy: Leader wakes, the judge, and the usage-limit fallback', () => {
  it('wakes the Leader on schedule, wakes the judge when the turn ends, falls back on a usage limit, and restores the primary model', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-autonomy-'))
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')
    const binDir = path.join(root, 'bin')
    const tmuxReg = path.join(root, 'tmux.reg')
    const sentLog = path.join(root, 'sent.log')
    const commandLog = path.join(root, 'commands.log')
    const handoffLog = path.join(root, 'handoff.log')
    fs.mkdirSync(path.join(home, 'rooms'), { recursive: true })
    fs.mkdirSync(path.join(home, '.feather'), { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(path.join(home, '.omp'), { recursive: true })
    fs.writeFileSync(path.join(home, '.omp/auth-gateway.token'), 'gateway-test-token\n', { mode: 0o600 })
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'tmux'), [
      '#!/bin/sh',
      'case "$1" in',
      '  list-sessions) if [ -f "$TMUX_REG" ]; then now=$(date +%s); while IFS= read -r n; do printf "%s|%s\\n" "$n" "$now"; done < "$TMUX_REG"; fi; exit 0 ;;',
      '  has-session) if [ -f "$TMUX_REG" ] && grep -qxF "$3" "$TMUX_REG"; then exit 0; fi; exit 1 ;;',
      '  new-session) printf "%s\\n" "$*" >> "$TMUX_COMMAND_LOG"; name=""; while [ $# -gt 0 ]; do [ "$1" = "-s" ] && name="$2"; shift; done; [ -n "$name" ] && printf "%s\\n" "$name" >> "$TMUX_REG"; exit 0 ;;',
      '  kill-session) printf "%s\\n" "$*" >> "$TMUX_COMMAND_LOG"; grep -vxF "$3" "$TMUX_REG" > "$TMUX_REG.next" || true; mv "$TMUX_REG.next" "$TMUX_REG"; exit 0 ;;',
      '  load-buffer) shift; [ "$1" = "-b" ] && shift 2; cat "$1" >> "$TMUX_SENT_LOG"; printf "\\n---\\n" >> "$TMUX_SENT_LOG"; exit 0 ;;',
      '  send-keys) if [ "$3" = "-l" ]; then printf "%s\\n---\\n" "$4" >> "$TMUX_SENT_LOG"; fi; exit 0 ;;',
      'esac',
      'exit 0',
    ].join('\n'))
    fs.chmodSync(path.join(binDir, 'tmux'), 0o755)
    // Fake `room` CLI: the handoff always succeeds.
    const roomCli = path.join(binDir, 'room')
    fs.writeFileSync(roomCli, [
      '#!/bin/sh',
      `printf "%s|%s\\n" "$*" "$PWD" >> ${JSON.stringify(handoffLog)}`,
      'echo "handoff appended"; exit 0',
    ].join('\n'))
    fs.chmodSync(roomCli, 0o755)
    const readSent = () => { try { return fs.readFileSync(sentLog, 'utf8') } catch { return '' } }
    const readMeta = () => JSON.parse(fs.readFileSync(path.join(stateDir, 'session-meta.json'), 'utf8'))
    // The fake tmux never finishes a turn, so a resident's Ralph loop is ended by hand.
    const finishRalph = (id) => {
      const meta = readMeta()
      meta[id] = { ...meta[id], ralph: { ...(meta[id]?.ralph || {}), status: 'complete' } }
      fs.writeFileSync(path.join(stateDir, 'session-meta.json'), JSON.stringify(meta, null, 2))
    }
    const readLeaders = () => JSON.parse(fs.readFileSync(path.join(home, '.feather/room-mains.json'), 'utf8'))
    const readResidents = () => JSON.parse(fs.readFileSync(path.join(home, '.feather/room-residents.json'), 'utf8'))
    const wakesFile = path.join(home, '.feather/room-leader-wakes.json')
    const readWakes = () => JSON.parse(fs.readFileSync(wakesFile, 'utf8'))
    const patchWakes = (patch) => fs.writeFileSync(wakesFile, JSON.stringify({ ...readWakes(), 'ev-shop': { ...readWakes()['ev-shop'], ...patch } }))
    // A fake OMP transcript for a Leader: what the scheduler reads to know
    // whether a wake turn has ended, and whether it died on a limit.
    const writeTranscript = (sessionId, messages) => {
      const dir = path.join(home, '.feather/omp-sessions', sessionId)
      fs.mkdirSync(dir, { recursive: true })
      const lines = [{ type: 'session', id: sessionId }, ...messages.map(message => ({ type: 'message', message }))]
      fs.writeFileSync(path.join(dir, '2026-09-07T00-00-00-000Z_test.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    }
    const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
    const assistant = (stopReason, extra = {}) => ({ role: 'assistant', provider: 'anthropic', model: 'claude-fable-5-1', stopReason, content: [{ type: 'text', text: 'ok' }], ...extra })

    const port = 33_000 + (process.pid % 1000)
    const base = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server.js'], {
      cwd: REPO,
      env: {
        ...process.env, HOME: home, FEATHER_STATE_DIR: stateDir, PORT: String(port),
        FEATHER_ROOM_PULSE_CHECK_MS: '50', FEATHER_ROOM_KICKOFF_DELAY_MS: '100', FEATHER_RESIDENT_RELAUNCH_SETTLE_MS: '50',
        FEATHER_ROOM_LEADER_WAKE_MIN_MS: '1000', FEATHER_ROOM_LEADER_USAGE_CHECK: '0',
        FEATHER_OMP_AUTH_GATEWAY_URL: 'http://127.0.0.1:14000', FEATHER_ROOM_CLI: roomCli,
        PATH: `${binDir}:${process.env.PATH}`, TMUX_REG: tmuxReg, TMUX_SENT_LOG: sentLog, TMUX_COMMAND_LOG: commandLog,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    try {
      let health
      for (let attempt = 0; attempt < 100 && !health; attempt++) {
        if (child.exitCode !== null) throw new Error(stderr)
        try { health = await (await fetch(`${base}/api/health`)).json() } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
      }
      const created = await post(`${base}/api/rooms`, { name: 'ev-shop', mission: 'run an EV-only auto shop' })
      const createdText = await created.text()
      assert.equal(created.status, 200, createdText)
      const room = JSON.parse(createdText)
      const firstLeader = room.leaderSessionId
      const roomDir = path.join(home, 'rooms/ev-shop')
      const rooms = async () => (await (await fetch(`${base}/api/rooms`)).json()).rooms.find(candidate => candidate.name === 'ev-shop')
      await waitFor(() => readSent().includes('[Room kickoff · #ev-shop]') || null, { message: 'kickoff' })
      // New Rooms seat the Leader plus an agent rule; the legacy residents (judge
      // included) come from the /staff migration path.
      assert.equal((await post(`${base}/api/rooms/ev-shop/staff`, {})).status, 200)

      // Validation and the off state.
      assert.equal((await post(`${base}/api/rooms/nowhere/leader/wake`, { wakeIntervalMs: 60_000 })).status, 404)
      assert.equal((await post(`${base}/api/rooms/ev-shop/leader/wake`, { wakeIntervalMs: 10 })).status, 400)
      assert.equal((await post(`${base}/api/rooms/ev-shop/leader/wake`, { paused: 'yes' })).status, 400)
      let snapshot = await rooms()
      assert.equal(snapshot.leaderWake.enabled, false)
      assert.equal(snapshot.leaderWake.wakeIntervalMs, null)
      assert.ok(fs.existsSync(path.join(roomDir, 'STEERING.md')), 'new Rooms are scaffolded with STEERING.md')
      assert.ok(fs.existsSync(path.join(roomDir, 'wiki/TODO.md')), 'new Rooms are scaffolded with a TODO queue')

      // Switching autonomy on schedules the first wake one interval out.
      const on = await post(`${base}/api/rooms/ev-shop/leader/wake`, { wakeIntervalMs: 3_600_000 })
      const onText = await on.text()
      assert.equal(on.status, 200, onText)
      const onBody = JSON.parse(onText)
      assert.equal(onBody.leaderWake.enabled, true)
      assert.equal(onBody.leaderWake.wakeIntervalMs, 3_600_000)
      assert.ok(onBody.leaderWake.nextWakeAtMs > Date.now() + 3_500_000)
      assert.equal(onBody.leaderWake.judgeDue, false)
      assert.equal(count(readSent(), /\[Room wake · #ev-shop · leader/g), 0)
      const leaderEntry = (await rooms()).residents.find(resident => resident.role === 'leader')
      assert.equal(leaderEntry.model, 'anthropic/claude-fable-5-1')
      assert.equal(leaderEntry.wakeIntervalMs, 3_600_000)

      // A due wake sends the Leader its wake prompt and marks the judge as pending.
      patchWakes({ nextWakeAtMs: 1 })
      const woken = await waitFor(() => readSent().includes('[Room wake · #ev-shop · leader') ? readSent() : null, { message: 'leader wake' })
      assert.ok(woken.includes('FRONTIER.md'))
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal(count(readSent(), /\[Room wake · #ev-shop · leader/g), 1, readSent())
      let wakes = readWakes()['ev-shop']
      assert.ok(wakes.nextWakeAtMs > Date.now() + 3_500_000)
      assert.ok(Number.isFinite(Date.parse(wakes.lastWakeAt)))
      assert.equal(wakes.judgeDue, true)
      // The judge waits while the Leader is still on that turn.
      const wakeStamp = `[Room wake · #ev-shop · leader · ${wakes.lastWakeAt}]`
      writeTranscript(firstLeader, [user('kickoff'), assistant('stop'), user(wakeStamp), assistant('toolUse')])
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(count(readSent(), /\[Room judge · #ev-shop/g), 0, 'judge waits for the turn to end')
      // ...and is woken once the turn ends, once.
      writeTranscript(firstLeader, [user('kickoff'), assistant('stop'), user(wakeStamp), assistant('toolUse'), assistant('stop')])
      const judged = await waitFor(() => readSent().includes('[Room judge · #ev-shop') ? readSent() : null, { message: 'judge wake' })
      assert.ok(judged.includes(`The Leader (chat ${firstLeader})`))
      assert.ok(judged.includes(wakes.lastWakeAt))
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(count(readSent(), /\[Room judge · #ev-shop/g), 1, readSent())
      wakes = readWakes()['ev-shop']
      assert.equal(wakes.judgeDue, false)
      assert.ok(Number.isFinite(Date.parse(wakes.lastJudgeAt)))
      const judgeId = readResidents()['ev-shop'].judge.sessionId
      assert.equal(readMeta()[judgeId].ralph.enabled, true)
      assert.equal(readMeta()[judgeId].ompModel, 'openai-codex/gpt-5.6-sol')
      assert.ok(Number.isFinite(Date.parse(readResidents()['ev-shop'].judge.lastWakeAt)))
      snapshot = await waitFor(async () => { const current = await rooms(); return current.leaderWake.judgeDue === false ? current : null }, { message: 'snapshot after judge wake' }).catch(() => null)
      if (!snapshot) snapshot = await rooms()
      assert.equal(snapshot.leaderWake.judgeDue, false)
      assert.equal(snapshot.leaderWake.lastJudgeAt, wakes.lastJudgeAt)

      // Paused: nothing wakes, even when due. Resuming re-arms from now.
      assert.equal((await post(`${base}/api/rooms/ev-shop/leader/wake`, { paused: true })).status, 200)
      patchWakes({ nextWakeAtMs: 1 })
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(count(readSent(), /\[Room wake · #ev-shop · leader/g), 1, 'no wake while paused')
      assert.equal((await rooms()).leaderWake.enabled, false)
      assert.equal((await post(`${base}/api/rooms/ev-shop/leader/wake`, { paused: false })).status, 200)
      assert.ok(readWakes()['ev-shop'].nextWakeAtMs > Date.now() + 3_500_000)

      // `judge: true` wakes the judge on demand; `now: true` wakes the Leader on demand.
      assert.equal((await post(`${base}/api/rooms/ev-shop/leader/wake`, { judge: true })).status, 200)
      assert.equal(count(readSent(), /\[Room judge · #ev-shop/g), 2)
      assert.equal((await post(`${base}/api/rooms/ev-shop/leader/wake`, { now: true })).status, 200)
      assert.equal(count(readSent(), /\[Room wake · #ev-shop · leader/g), 2)

      // A steer lands under Steers in STEERING.md, is logged, and fires the
      // Room's agents at once instead of waking the Leader.
      const steered = await post(`${base}/api/rooms/ev-shop/steer`, { text: 'Price the equipment first.' })
      const steeredText = await steered.text()
      assert.equal(steered.status, 201, steeredText)
      const steerBody = JSON.parse(steeredText)
      assert.equal(steerBody.file, 'STEERING.md')
      assert.deepEqual(steerBody.fired, ['ev-shop/agent'])
      assert.equal(steerBody.leaderSessionId, null)
      const steering = fs.readFileSync(path.join(home, 'rooms/ev-shop/STEERING.md'), 'utf8')
      assert.match(steering, /## Steers\n[\s\S]*- \d{4}-\d{2}-\d{2} \d{2}:\d{2} Price the equipment first\.\n$/)
      assert.match(fs.readFileSync(path.join(home, 'rooms/ev-shop/wiki/Log.md'), 'utf8'), /\[steer\] Price the equipment first\./)
      assert.equal(count(readSent(), /\[Room steer · #ev-shop/g), 0, 'the Leader is not woken by a steer')
      await waitFor(() => readSent().includes('[Room wake · #ev-shop · agent agent · checker') ? readSent() : null, { message: 'checker primed after steer' })
      // The builder starts once the checker is primed; its wake prompt is the OMP session's first message.
      const builderPrompts = () => [path.join(home, '.feather/omp-sessions'), path.join(stateDir, 'omp-sessions')]
        .filter(dir => fs.existsSync(dir))
        .flatMap(dir => fs.readdirSync(dir, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => path.join(dir, entry.name, 'scheduled-prompt.md')))
        .filter(file => fs.existsSync(file))
        .map(file => fs.readFileSync(file, 'utf8'))
      await waitFor(() => builderPrompts().some(prompt => prompt.startsWith('[Room wake · #ev-shop · agent agent · builder')) || null, { attempts: 400, message: 'builder started with its wake prompt' })
      assert.equal((await post(`${base}/api/rooms/ev-shop/steer`, { text: '   ' })).status, 400)
      assert.equal((await post(`${base}/api/rooms/no-such-room/steer`, { text: 'x' })).status, 404)

      // Usage-limit fallback: the Leader's last turn died on a limit, so the
      // scheduler retires it (handoff written) and seats a Leader on the
      // fallback model, whose opening says why and keeps working.
      writeTranscript(firstLeader, [user('kickoff'), assistant('stop'), user(wakeStamp), assistant('error', { errorMessage: 'Usage limit reached for claude-fable-5-1. Resets at 6pm.' })])
      const fallbackLeader = await waitFor(() => { const id = readLeaders()['ev-shop']; return id && id !== firstLeader && readMeta()[id] ? id : null }, { message: 'fallback succession' })
      assert.equal(readMeta()[fallbackLeader].ompModel, 'openai-codex/gpt-5.6-sol')
      assert.match(fs.readFileSync(handoffLog, 'utf8'), new RegExp(`^-r ev-shop handoff ${firstLeader}\\|`, 'm'))
      const handover = await waitFor(() => readSent().includes('usage-limit fallback') ? readSent() : null, { message: 'fallback opening' })
      assert.ok(handover.includes('hit a usage limit: Usage limit reached'))
      assert.ok(handover.includes('Its handoff is the last "## Handoff" section in notes.md'))
      wakes = readWakes()['ev-shop']
      assert.equal(wakes.fallback.model, 'openai-codex/gpt-5.6-sol')
      assert.equal(wakes.fallback.primaryModel, 'anthropic/claude-fable-5-1')
      assert.equal(wakes.fallback.attempts, 1)
      assert.equal(wakes.fallbackAttempts, 1)
      assert.ok(wakes.fallback.retryAtMs > Date.now() + 3_500_000, 'first retry is an hour out')
      snapshot = await rooms()
      assert.equal(snapshot.leaderWake.fallback.model, 'openai-codex/gpt-5.6-sol')
      assert.equal(snapshot.residents.find(resident => resident.role === 'leader').model, 'openai-codex/gpt-5.6-sol')
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(Object.keys(readLeaders()).length, 1)
      assert.equal(readLeaders()['ev-shop'], fallbackLeader, 'no second succession while the fallback holds')
      // The handover turn ending wakes the judge like a wake does, once the judge's own turn is over.
      const openingCount = count(readSent(), /\[Room judge · #ev-shop/g)
      finishRalph(readResidents()['ev-shop'].judge.sessionId)
      writeTranscript(fallbackLeader, [user(`[Room handover · #ev-shop · usage-limit fallback]`), assistant('stop', { provider: 'openai-codex', model: 'gpt-5.6-sol' })])
      await waitFor(() => count(readSent(), /\[Room judge · #ev-shop/g) > openingCount || null, { message: 'judge after handover' })

      // Once the retry time passes, the primary model is restored.
      patchWakes({ fallback: { ...readWakes()['ev-shop'].fallback, retryAtMs: 1 } })
      const restoredLeader = await waitFor(() => { const id = readLeaders()['ev-shop']; return id && id !== fallbackLeader && readMeta()[id] ? id : null }, { message: 'restore succession' })
      assert.equal(readMeta()[restoredLeader].ompModel, 'anthropic/claude-fable-5-1')
      await waitFor(() => readSent().includes('primary model restored') || null, { message: 'restore opening' })
      wakes = readWakes()['ev-shop']
      assert.equal(wakes.fallback, null)
      assert.equal(wakes.fallbackAttempts, 1, 'attempts persist until a clean primary turn')
      writeTranscript(restoredLeader, [user('[Room handover · #ev-shop · primary model restored]'), assistant('stop')])
      await waitFor(() => readWakes()['ev-shop'].fallbackAttempts === 0 || null, { message: 'attempts cleared' })

      // Switching autonomy off clears the schedule.
      const off = await (await post(`${base}/api/rooms/ev-shop/leader/wake`, { wakeIntervalMs: null })).json()
      assert.equal(off.leaderWake.enabled, false)
      assert.equal(off.leaderWake.nextWakeAtMs, null)
    } finally {
      child.kill('SIGKILL')
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
