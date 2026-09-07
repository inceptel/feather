import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

const REPO = path.resolve(import.meta.dirname, '../..')

async function waitFor(predicate, { attempts = 200, delay = 25, message = 'condition' } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, delay))
  }
  throw new Error(`timed out waiting for ${message}`)
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('Room Leader succession', () => {
  it('shows a just-appointed Leader before its first turn, refuses to retire when the handoff fails, and otherwise retires and reseats', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-succession-'))
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')
    const binDir = path.join(root, 'bin')
    const tmuxReg = path.join(root, 'tmux.reg')
    const sentLog = path.join(root, 'sent.log')
    const commandLog = path.join(root, 'commands.log')
    const handoffLog = path.join(root, 'handoff.log')
    const handoffMode = path.join(root, 'handoff.mode')
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
    // Fake `room` CLI: records its arguments; succeeds or fails per handoff.mode.
    const roomCli = path.join(binDir, 'room')
    fs.writeFileSync(roomCli, [
      '#!/bin/sh',
      `printf "%s|%s|%s\\n" "$*" "$PWD" "$FEATHER_URL" >> ${JSON.stringify(handoffLog)}`,
      `if [ "$(cat ${JSON.stringify(handoffMode)})" = ok ]; then echo "handoff appended"; exit 0; fi`,
      'echo "room: distiller output failed validation" >&2; exit 1',
    ].join('\n'))
    fs.chmodSync(roomCli, 0o755)
    fs.writeFileSync(handoffMode, 'fail')
    const readSent = () => { try { return fs.readFileSync(sentLog, 'utf8') } catch { return '' } }
    const readMeta = () => JSON.parse(fs.readFileSync(path.join(stateDir, 'session-meta.json'), 'utf8'))
    const readLeaders = () => JSON.parse(fs.readFileSync(path.join(home, '.feather/room-mains.json'), 'utf8'))

    const port = 32_000 + (process.pid % 1000)
    const base = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server.js'], {
      cwd: REPO,
      env: {
        ...process.env, HOME: home, FEATHER_STATE_DIR: stateDir, PORT: String(port),
        FEATHER_ROOM_PULSE_CHECK_MS: '50', FEATHER_ROOM_KICKOFF_DELAY_MS: '100', FEATHER_RESIDENT_RELAUNCH_SETTLE_MS: '50',
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
      assert.match(firstLeader, /^[0-9a-f-]{36}$/)
      assert.match(fs.readFileSync(commandLog, 'utf8'), /--model anthropic\/claude-fable-5-1/)

      // Projection: no transcript exists yet, but the Leader is still reported.
      const rooms = async () => (await (await fetch(`${base}/api/rooms`)).json()).rooms.find(candidate => candidate.name === 'ev-shop')
      let snapshot = await rooms()
      assert.equal(snapshot.leaderSessionId, firstLeader)
      const leaderEntry = snapshot.residents.find(resident => resident.role === 'leader')
      assert.equal(leaderEntry.status, 'starting')
      assert.equal(leaderEntry.sessionId, firstLeader)

      // Handoff failure keeps the Leader in place.
      const refused = await post(`${base}/api/rooms/ev-shop/leader/succeed`, {})
      assert.equal(refused.status, 502)
      assert.match((await refused.json()).error, /handoff failed/)
      assert.equal(readLeaders()['ev-shop'], firstLeader)
      assert.match(fs.readFileSync(handoffLog, 'utf8'), new RegExp(`^-r ev-shop handoff ${firstLeader}\\|${path.join(home, 'rooms/ev-shop')}\\|${base}$`, 'm'))
      assert.equal((await post(`${base}/api/rooms/nowhere/leader/succeed`, {})).status, 404)
      assert.equal((await post(`${base}/api/rooms/ev-shop/leader/succeed`, { model: 'bad model' })).status, 400)

      // A successful handoff retires the old Leader and seats a new one.
      fs.writeFileSync(handoffMode, 'ok')
      const succeeded = await post(`${base}/api/rooms/ev-shop/leader/succeed`, { model: 'anthropic/claude-opus-5' })
      const successionText = await succeeded.text()
      assert.equal(succeeded.status, 200, successionText)
      const succession = JSON.parse(successionText)
      assert.equal(succession.retiredSessionId, firstLeader)
      assert.equal(succession.handoff, 'appended')
      assert.equal(succession.model, 'anthropic/claude-opus-5')
      const secondLeader = succession.leaderSessionId
      assert.notEqual(secondLeader, firstLeader)
      assert.equal(readLeaders()['ev-shop'], secondLeader)
      const assignments = JSON.parse(fs.readFileSync(path.join(home, '.feather/room-sessions.json'), 'utf8'))
      assert.equal(assignments[firstLeader], 'ev-shop', 'retired Leader stays assigned so its history is visible')
      assert.equal(assignments[secondLeader], 'ev-shop')
      assert.equal(readMeta()[secondLeader].ompModel, 'anthropic/claude-opus-5')
      assert.equal(readMeta()[secondLeader].title, '#ev-shop')
      assert.match(fs.readFileSync(commandLog, 'utf8'), new RegExp(`kill-session -t feather-${firstLeader.slice(0, 8)}`))
      assert.ok(!fs.readFileSync(tmuxReg, 'utf8').includes(firstLeader))
      snapshot = await rooms()
      assert.equal(snapshot.leaderSessionId, secondLeader)
      await waitFor(() => readSent().includes(`new Leader of #ev-shop`) || null, { message: 'succession opening message' })
      assert.match(readSent(), new RegExp(`predecessor \\(chat ${firstLeader}\\)`))

      // "Start Leader chat" after succession reuses the new Leader.
      const reuse = await post(`${base}/api/sessions`, { id: '11111111-1111-4111-8111-111111111111', cwd: path.join(home, 'rooms/ev-shop'), agent: 'omp', roomName: 'ev-shop', roomRole: 'leader' })
      assert.equal(reuse.status, 200, await reuse.clone().text())
      assert.equal((await reuse.json()).id, secondLeader)

      // Skipping the handoff is explicit.
      const skipped = await post(`${base}/api/rooms/ev-shop/leader/succeed`, { handoff: false })
      assert.equal(skipped.status, 200, await skipped.clone().text())
      const skippedBody = await skipped.json()
      assert.equal(skippedBody.handoff, 'skipped')
      assert.equal(skippedBody.retiredSessionId, secondLeader)
      assert.equal(readLeaders()['ev-shop'], skippedBody.leaderSessionId)
      assert.equal(readMeta()[skippedBody.leaderSessionId].ompModel, 'anthropic/claude-fable-5-1')
    } finally {
      child.kill('SIGKILL')
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
