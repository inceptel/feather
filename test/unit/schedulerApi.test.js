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
const json = async (response) => { const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null, text } }
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
const put = (url, body) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const count = (text, re) => (text.match(re) || []).length

describe('Scheduler API: rules, chains, runs, and the handoff from the old wake code', () => {
  it('fires a due rule once, waits for the turn to end, chains the judge, and blocks bad rules', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-scheduler-'))
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')
    const binDir = path.join(root, 'bin')
    const tmuxReg = path.join(root, 'tmux.reg')
    const sentLog = path.join(root, 'sent.log')
    const commandLog = path.join(root, 'commands.log')
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
    const roomCli = path.join(binDir, 'room')
    fs.writeFileSync(roomCli, '#!/bin/sh\necho "handoff appended"; exit 0\n')
    fs.chmodSync(roomCli, 0o755)
    const readSent = () => { try { return fs.readFileSync(sentLog, 'utf8') } catch { return '' } }
    const metaFile = path.join(stateDir, 'session-meta.json')
    const readMeta = () => JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    const finishRalph = (id) => {
      const meta = readMeta()
      meta[id] = { ...meta[id], ralph: { ...(meta[id]?.ralph || {}), status: 'complete' } }
      fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2))
    }
    const schedulerFile = path.join(home, '.feather/scheduler.json')
    const readScheduler = () => JSON.parse(fs.readFileSync(schedulerFile, 'utf8'))
    const patchRuntime = (id, patch) => {
      const state = readScheduler()
      state.runtime[id] = { ...(state.runtime[id] || {}), ...patch }
      fs.writeFileSync(schedulerFile, JSON.stringify(state))
    }
    const writeTranscript = (sessionId, messages) => {
      const dir = path.join(home, '.feather/omp-sessions', sessionId)
      fs.mkdirSync(dir, { recursive: true })
      const lines = [{ type: 'session', id: sessionId }, ...messages.map(message => ({ type: 'message', message }))]
      fs.writeFileSync(path.join(dir, '2026-09-07T00-00-00-000Z_test.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    }
    const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
    const assistant = (stopReason) => ({ role: 'assistant', provider: 'anthropic', model: 'claude-fable-5-1', stopReason, content: [{ type: 'text', text: 'ok' }] })

    const port = 34_000 + (process.pid % 1000)
    const base = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server.js'], {
      cwd: REPO,
      env: {
        ...process.env, HOME: home, FEATHER_STATE_DIR: stateDir, PORT: String(port),
        FEATHER_ROOM_PULSE_CHECK_MS: '50', FEATHER_ROOM_KICKOFF_DELAY_MS: '50', FEATHER_RESIDENT_RELAUNCH_SETTLE_MS: '50',
        FEATHER_ROOM_LEADER_WAKE_MIN_MS: '1000', FEATHER_ROOM_LEADER_USAGE_CHECK: '0',
        FEATHER_SCHEDULER_CHECK_MS: '50', FEATHER_SCHEDULER_BOOT_GRACE_MS: '0',
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
      const created = await json(await post(`${base}/api/rooms`, { name: 'ev-shop', mission: 'run an EV-only auto shop' }))
      assert.equal(created.status, 200, created.text)
      const leaderId = created.body.leaderSessionId
      const roomDir = path.join(home, 'rooms/ev-shop')
      await waitFor(() => readSent().includes('[Room kickoff · #ev-shop]') || null, { message: 'kickoff' })
      const judgeId = JSON.parse(fs.readFileSync(path.join(home, '.feather/room-residents.json'), 'utf8'))['ev-shop']?.judge?.sessionId
      assert.ok(judgeId, 'judge resident exists')

      // Empty table; bad rules never land.
      let snapshot = (await json(await fetch(`${base}/api/scheduler`))).body
      assert.equal(snapshot.enabled, true)
      assert.deepEqual(snapshot.rules, [])
      assert.equal((await put(`${base}/api/scheduler/rules/nowhere/leader`, { target: { kind: 'leader' }, every: '1h' })).status, 404)
      assert.equal((await put(`${base}/api/scheduler/rules/ev-shop/leader`, { target: { kind: 'leader' }, every: '5s' })).status, 400)
      assert.equal((await put(`${base}/api/scheduler/rules/ev-shop/judge`, { target: { kind: 'resident', role: 'judge' }, after: 'ev-shop/leader' })).status, 400, 'chain to a missing parent')

      // A new interval rule arms from now: no wake on creation.
      const leaderRule = await json(await put(`${base}/api/scheduler/rules/ev-shop/leader`, { target: { kind: 'leader' }, mode: 'inject', every: '1h', when: [{ type: 'idle', forceAfterMs: '30m' }] }))
      assert.equal(leaderRule.status, 200, leaderRule.text)
      assert.equal(leaderRule.body.rule.every, '1h')
      assert.ok(Date.parse(leaderRule.body.rule.runtime.nextDueAt) > Date.now() + 3_500_000)
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal(count(readSent(), /\[Room wake · #ev-shop · leader/g), 0)
      // Cycles are refused at the table level.
      const cycle = await json(await put(`${base}/api/scheduler/rules/ev-shop/caretaker`, { target: { kind: 'resident', role: 'caretaker' }, after: 'ev-shop/leader' }))
      assert.equal(cycle.status, 200, cycle.text)
      const loop = await json(await put(`${base}/api/scheduler/rules/ev-shop/leader`, { target: { kind: 'leader' }, mode: 'inject', after: 'ev-shop/caretaker' }))
      assert.equal(loop.status, 400)
      assert.match(loop.body.error, /cycle/)
      assert.equal((await fetch(`${base}/api/scheduler/rules/ev-shop/caretaker`, { method: 'DELETE' })).status, 200)

      // The old Leader-wake checker leaves a scheduler-owned Room alone.
      const legacy = await json(await post(`${base}/api/rooms/ev-shop/leader/wake`, { wakeIntervalMs: 1000 }))
      assert.equal(legacy.status, 200, legacy.text)
      await new Promise(resolve => setTimeout(resolve, 400))
      assert.equal(count(readSent(), /\[Room wake · #ev-shop · leader/g), 0, 'legacy wake suppressed')

      // Five missed hours fire exactly once.
      writeTranscript(leaderId, [user('kickoff'), assistant('stop')])
      patchRuntime('ev-shop/leader', { lastRunAt: new Date(Date.now() - 5 * 3_600_000).toISOString() })
      await waitFor(() => readSent().includes('[Room wake · #ev-shop · leader') || null, { message: 'leader wake' })
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(count(readSent(), /\[Room wake · #ev-shop · leader/g), 1)
      let leaderEntry = await waitFor(async () => {
        const entry = (await json(await fetch(`${base}/api/scheduler`))).body.rules.find(rule => rule.id === 'ev-shop/leader')
        return entry.runtime.running?.sessionId ? entry : null
      }, { message: 'run records its session' })
      assert.equal(leaderEntry.runtime.running.sessionId, leaderId)
      const startedAt = leaderEntry.runtime.lastRunAt
      assert.equal((await post(`${base}/api/scheduler/rules/ev-shop/leader/fire`)).status, 409, 'no overlap')

      // The judge rule chains on the Leader run, but only once Review has lines.
      const judgeRule = await json(await put(`${base}/api/scheduler/rules/ev-shop/judge`, { target: { kind: 'resident', role: 'judge' }, after: 'ev-shop/leader', when: [{ type: 'frontier-has', section: 'Review' }] }))
      assert.equal(judgeRule.status, 200, judgeRule.text)
      // The Leader's turn ends.
      const marker = `[Room wake · #ev-shop · leader · ${startedAt}]`
      writeTranscript(leaderId, [user('kickoff'), assistant('stop'), user(marker), assistant('toolUse')])
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.ok((await json(await fetch(`${base}/api/scheduler`))).body.rules.find(rule => rule.id === 'ev-shop/leader').runtime.running, 'mid-turn keeps the run open')
      writeTranscript(leaderId, [user('kickoff'), assistant('stop'), user(marker), assistant('stop')])
      await waitFor(async () => {
        const entry = (await json(await fetch(`${base}/api/scheduler`))).body.rules.find(rule => rule.id === 'ev-shop/leader')
        return entry.runtime.running === null && entry.runtime.lastOutcome === 'done' ? entry : null
      }, { message: 'leader run done' })
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal(count(readSent(), /\[Room judge · #ev-shop/g), 0, 'judge waits for Review lines')
      let judgeEntry = (await json(await fetch(`${base}/api/scheduler`))).body.rules.find(rule => rule.id === 'ev-shop/judge')
      assert.equal(judgeEntry.lastDecision, 'FRONTIER Review is empty')
      const frontier = fs.readFileSync(path.join(roomDir, 'FRONTIER.md'), 'utf8')
      fs.writeFileSync(path.join(roomDir, 'FRONTIER.md'), frontier.replace(/## Review\n/, '## Review\n- Shop pricing page drafted (wiki/Pricing.md)\n'))
      await waitFor(() => readSent().includes('[Room judge · #ev-shop') || null, { message: 'judge wake' })
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(count(readSent(), /\[Room judge · #ev-shop/g), 1, 'one judge wake per Leader run')
      judgeEntry = (await json(await fetch(`${base}/api/scheduler`))).body.rules.find(rule => rule.id === 'ev-shop/judge')
      assert.ok(judgeEntry.runtime.running, 'ralph resident run stays open while working')
      finishRalph(judgeId)
      await waitFor(async () => {
        const entry = (await json(await fetch(`${base}/api/scheduler`))).body.rules.find(rule => rule.id === 'ev-shop/judge')
        return entry.runtime.lastOutcome === 'done' ? entry : null
      }, { message: 'judge run done' })

      // Ledger, pause, resume, fire.
      const runs = (await json(await fetch(`${base}/api/scheduler/runs?room=ev-shop`))).body.runs
      assert.ok(runs.some(run => run.ruleId === 'ev-shop/leader' && run.event === 'finished' && run.outcome === 'done'))
      assert.ok(runs.some(run => run.ruleId === 'ev-shop/judge' && run.event === 'finished' && run.outcome === 'done'))
      const paused = await json(await post(`${base}/api/scheduler/rules/ev-shop/leader/pause`))
      assert.equal(paused.body.rule.runtime.paused, true)
      patchRuntime('ev-shop/leader', { lastRunAt: new Date(Date.now() - 5 * 3_600_000).toISOString() })
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(count(readSent(), /\[Room wake · #ev-shop · leader/g), 1, 'paused rules stay quiet')
      const resumed = await json(await post(`${base}/api/scheduler/rules/ev-shop/leader/resume`))
      assert.equal(resumed.body.rule.runtime.paused, false)
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(count(readSent(), /\[Room wake · #ev-shop · leader/g), 1, 'resume re-arms from now, no burst')
      const fired = await json(await post(`${base}/api/scheduler/rules/ev-shop/leader/fire`))
      assert.equal(fired.status, 200, fired.text)
      await waitFor(() => count(readSent(), /\[Room wake · #ev-shop · leader/g) === 2 || null, { message: 'manual fire' })
      // The read-only snapshot lists every rule, and the state file validates.
      assert.equal(Object.keys(readScheduler().rules).length, 2)
    } finally {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
