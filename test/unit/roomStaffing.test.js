import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'

const REPO = path.resolve(import.meta.dirname, '../..')
const MISSION = 'go investigate this one spot that\'s available for rent or for purchase and build me a business plan for what it would look like to run an EV-only auto shop out of that location'

async function waitFor(predicate, { attempts = 200, delay = 25, message = 'condition' } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, delay))
  }
  throw new Error(`timed out waiting for ${message}`)
}

describe('Room staffing from the template', () => {
  it('creates a Leader and three Ralph residents, kicks off the mission, wakes residents on schedule, and routes feed comments to the Leader', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-staffing-'))
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
    // Fake tmux: every launched session stays "live"; pasted input is logged.
    fs.writeFileSync(path.join(binDir, 'tmux'), [
      '#!/bin/sh',
      'case "$1" in',
      '  list-sessions) if [ -f "$TMUX_REG" ]; then now=$(date +%s); while IFS= read -r n; do printf "%s|%s\\n" "$n" "$now"; done < "$TMUX_REG"; fi; exit 0 ;;',
      '  has-session) if [ -f "$TMUX_REG" ] && grep -qxF "$3" "$TMUX_REG"; then exit 0; fi; exit 1 ;;',
      '  new-session) printf "%s\\n" "$*" >> "$TMUX_COMMAND_LOG"; name=""; while [ $# -gt 0 ]; do [ "$1" = "-s" ] && name="$2"; shift; done; [ -n "$name" ] && printf "%s\\n" "$name" >> "$TMUX_REG"; exit 0 ;;',
      '  load-buffer) shift; [ "$1" = "-b" ] && shift 2; cat "$1" >> "$TMUX_SENT_LOG"; printf "\\n---\\n" >> "$TMUX_SENT_LOG"; exit 0 ;;',
      '  send-keys) if [ "$3" = "-l" ]; then printf "%s\\n---\\n" "$4" >> "$TMUX_SENT_LOG"; fi; exit 0 ;;',
      'esac',
      'exit 0',
    ].join('\n'))
    fs.chmodSync(path.join(binDir, 'tmux'), 0o755)
    const readSent = () => { try { return fs.readFileSync(sentLog, 'utf8') } catch { return '' } }
    const readResidents = () => JSON.parse(fs.readFileSync(path.join(home, '.feather/room-residents.json'), 'utf8'))
    const readMeta = () => JSON.parse(fs.readFileSync(path.join(stateDir, 'session-meta.json'), 'utf8'))

    const port = 31_000 + (process.pid % 1000)
    const base = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server.js'], {
      cwd: REPO,
      env: {
        ...process.env, HOME: home, FEATHER_STATE_DIR: stateDir, PORT: String(port),
        FEATHER_ROOM_PULSE_CHECK_MS: '50', FEATHER_ROOM_KICKOFF_DELAY_MS: '100', FEATHER_RESIDENT_RELAUNCH_SETTLE_MS: '50',
        FEATHER_OMP_AUTH_GATEWAY_URL: 'http://127.0.0.1:14000',
        PATH: `${binDir}:${process.env.PATH}`, TMUX_REG: tmuxReg, TMUX_SENT_LOG: sentLog, TMUX_COMMAND_LOG: commandLog,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    try {
      await waitFor(() => child.exitCode === null && fs.existsSync(path.join(stateDir, 'session-meta.json')) || null, { message: 'server start' }).catch(() => {})
      let health
      for (let attempt = 0; attempt < 100 && !health; attempt++) {
        if (child.exitCode !== null) throw new Error(stderr)
        try { health = await (await fetch(`${base}/api/health`)).json() } catch { await new Promise(resolve => setTimeout(resolve, 50)) }
      }

      const bad = await fetch(`${base}/api/rooms`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ev-shop', staff: true }),
      })
      assert.equal(bad.status, 400)

      const created = await fetch(`${base}/api/rooms`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ev-shop', mission: `  ${MISSION}\r\n` }),
      })
      const createdText = await created.text()
      assert.equal(created.status, 200, createdText)
      const room = JSON.parse(createdText)
      assert.equal(room.mission, MISSION)
      assert.match(room.leaderSessionId, /^[0-9a-f-]{36}$/)
      assert.deepEqual(room.residents.map(resident => [resident.role, resident.wakeIntervalMs]),
        [['caretaker', 900_000], ['updater', 1_800_000], ['marketer', null]])
      const roomDir = path.join(home, 'rooms/ev-shop')
      assert.ok(fs.readFileSync(path.join(roomDir, 'AGENTS.md'), 'utf8').includes(`> ${MISSION}`))
      assert.equal(fs.readlinkSync(path.join(roomDir, 'CLAUDE.md')), 'AGENTS.md')
      assert.ok(fs.existsSync(path.join(roomDir, 'wiki/Home.md')))

      const duplicate = await fetch(`${base}/api/rooms`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ev-shop', mission: MISSION }),
      })
      assert.equal(duplicate.status, 409)

      // Durable state: leader, residents with their wake schedule, pulse paused.
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.feather/room-mains.json'), 'utf8'))['ev-shop'], room.leaderSessionId)
      const residents = readResidents()['ev-shop']
      const caretakerId = residents.caretaker.sessionId
      assert.equal(residents.caretaker.wakeIntervalMs, 900_000)
      assert.ok(residents.caretaker.nextWakeAtMs > Date.now() + 800_000)
      assert.equal(residents.marketer.wakeIntervalMs, null)
      assert.equal(residents.marketer.nextWakeAtMs, null)
      const pulses = JSON.parse(fs.readFileSync(path.join(home, '.feather/room-pulses.json'), 'utf8'))
      assert.equal(pulses['ev-shop'].enabled, false)
      assert.equal(pulses['ev-shop'].status, 'paused')
      const meta = readMeta()
      assert.equal(meta[room.leaderSessionId].title, '#ev-shop')
      assert.equal(meta[caretakerId].title, 'caretaker: #ev-shop')
      assert.equal(meta[caretakerId].mode, 'ralph')
      assert.equal(meta[room.leaderSessionId].mode ?? null, null)
      const assignments = JSON.parse(fs.readFileSync(path.join(home, '.feather/room-sessions.json'), 'utf8'))
      for (const resident of room.residents) assert.equal(assignments[resident.sessionId], 'ev-shop')
      const snapshot = await (await fetch(`${base}/api/rooms/ev-shop/residents`)).json()
      assert.deepEqual(snapshot.residents.map(resident => resident.role).sort(), ['caretaker', 'marketer', 'updater'])
      const ompIds = [room.leaderSessionId, ...room.residents.map(resident => resident.sessionId)]
      const commands = fs.readFileSync(commandLog, 'utf8')
      assert.equal((commands.match(/--no-extensions/g) || []).length, 4)
      assert.equal((commands.match(/-u OPENAI_API_KEY/g) || []).length, 4)
      assert.ok((commands.match(/feather-bridge\.js/g) || []).length >= 4)
      assert.ok((commands.match(/feather-protocol-tools\.js/g) || []).length >= 4)
      for (const sessionId of ompIds) {
        const agentDir = path.join(home, '.feather/omp-agents', sessionId)
        assert.equal(fs.statSync(agentDir).mode & 0o777, 0o700)
        assert.equal(fs.statSync(path.join(agentDir, 'models.yml')).mode & 0o777, 0o600)
        assert.match(commands, new RegExp(`PI_CODING_AGENT_DIR=.*${sessionId}`))
        assert.equal(fs.readlinkSync(path.join(agentDir, 'extensions/feather-bridge.js')), path.join(REPO, 'omp-extensions/feather-bridge.js'))
        assert.equal(fs.readlinkSync(path.join(agentDir, 'extensions/feather-protocol-tools.js')), path.join(REPO, 'omp-tools/feather-protocol-tools.js'))
        assert.equal(fs.readlinkSync(path.join(agentDir, 'skills/council')), path.join(REPO, 'skills/council'))
        const models = fs.readFileSync(path.join(agentDir, 'models.yml'), 'utf8')
        assert.ok(models.includes('baseUrl: \"http://127.0.0.1:14000\"'))
        assert.ok(models.includes(`apiKey: \"!cat '${path.join(home, '.omp/auth-gateway.token')}'\"`))
        assert.ok(!models.includes('gateway-test-token'))
      }
      assert.equal(new Set(ompIds.map(sessionId => path.join(home, '.feather/omp-agents', sessionId))).size, 4)

      // A pre-template Room can be migrated without replacing its Leader or
      // specialist. Standard charters and cadence are applied idempotently.
      const frictionDir = path.join(home, 'rooms/friction')
      fs.mkdirSync(frictionDir, { recursive: true })
      fs.writeFileSync(path.join(frictionDir, 'AGENTS.md'), '# Room: #friction\n')
      fs.writeFileSync(path.join(frictionDir, 'notes.md'), '# notes\n')
      fs.writeFileSync(path.join(frictionDir, 'CARETAKER.md'), 'legacy caretaker\n')
      fs.writeFileSync(path.join(frictionDir, 'RESOLVER.md'), 'specialist contract\n')
      const createFrictionSession = async (body) => {
        const response = await fetch(`${base}/api/sessions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: randomUUID(), cwd: frictionDir, roomName: 'friction', agent: 'omp', ...body }),
        })
        const text = await response.text()
        assert.equal(response.status, 200, text)
        return JSON.parse(text)
      }
      const frictionLeader = await createFrictionSession({ roomRole: 'leader' })
      const legacyCaretaker = await createFrictionSession({ roomRole: 'caretaker', mode: 'ralph' })
      const legacyResolver = await createFrictionSession({ roomRole: 'resolver', mode: 'ralph' })
      const migratedResponse = await fetch(`${base}/api/rooms/friction/staff`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specialists: { resolver: 900_000 } }),
      })
      const migratedText = await migratedResponse.text()
      assert.equal(migratedResponse.status, 200, migratedText)
      const migrated = JSON.parse(migratedText)
      assert.equal(migrated.leaderSessionId, frictionLeader.id)
      assert.deepEqual(migrated.created, ['updater', 'marketer'])
      assert.deepEqual(migrated.residents.map(resident => resident.role).sort(),
        ['caretaker', 'marketer', 'resolver', 'updater'])
      const frictionResidents = readResidents().friction
      assert.equal(frictionResidents.caretaker.sessionId, legacyCaretaker.id)
      assert.equal(frictionResidents.caretaker.wakeIntervalMs, 900_000)
      assert.equal(frictionResidents.updater.wakeIntervalMs, 1_800_000)
      assert.equal(frictionResidents.marketer.wakeIntervalMs, null)
      assert.equal(frictionResidents.resolver.sessionId, legacyResolver.id)
      assert.equal(frictionResidents.resolver.wakeIntervalMs, 900_000)
      assert.ok(Object.values(frictionResidents).every(resident => resident.paused === false))
      assert.ok(frictionResidents.resolver.nextWakeAtMs > Date.now() + 800_000)
      const frictionPulse = JSON.parse(fs.readFileSync(path.join(home, '.feather/room-pulses.json'), 'utf8')).friction
      assert.equal(frictionPulse.enabled, false)
      assert.equal(frictionPulse.status, 'paused')
      assert.match(fs.readFileSync(path.join(frictionDir, 'CARETAKER.md'), 'utf8'), /resident caretaker/)
      assert.match(fs.readFileSync(path.join(frictionDir, 'UPDATER.md'), 'utf8'), /\*\*By the way\*\*/)
      assert.ok(fs.existsSync(path.join(frictionDir, 'MARKETER.md')))
      assert.equal(fs.readFileSync(path.join(frictionDir, 'RESOLVER.md'), 'utf8'), 'specialist contract\n')
      for (const sub of ['wiki', 'artifacts', '.caretaker', '.updater']) {
        assert.ok(fs.statSync(path.join(frictionDir, sub)).isDirectory(), sub)
      }
      assert.equal(fs.readlinkSync(path.join(frictionDir, 'CLAUDE.md')), 'AGENTS.md')

      const beforeRetry = Object.fromEntries(Object.entries(frictionResidents).map(([role, resident]) => [role, resident.sessionId]))
      const retryResponse = await fetch(`${base}/api/rooms/friction/staff`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specialists: { resolver: 900_000 } }),
      })
      const retryText = await retryResponse.text()
      assert.equal(retryResponse.status, 200, retryText)
      assert.deepEqual(JSON.parse(retryText).created, [])
      assert.deepEqual(Object.fromEntries(Object.entries(readResidents().friction).map(([role, resident]) => [role, resident.sessionId])), beforeRetry)

      // The Leader gets the mission, verbatim, once the session has settled.
      const kickoff = await waitFor(() => readSent().includes('[Room kickoff · #ev-shop]') ? readSent() : null, { message: 'kickoff prompt' })
      assert.ok(kickoff.includes(`> ${MISSION}`))
      assert.equal((kickoff.match(/\[Room kickoff/g) || []).length, 1)

      // Wake scheduler: a due caretaker gets its charter prompt; the others wait.
      fs.writeFileSync(path.join(home, '.feather/room-residents.json'), JSON.stringify({
        'ev-shop': { ...residents, caretaker: { ...residents.caretaker, nextWakeAtMs: 1 } },
      }))
      const woken = await waitFor(() => readSent().includes('[Room wake · #ev-shop · caretaker') ? readSent() : null, { message: 'caretaker wake' })
      assert.ok(woken.includes('Re-read CARETAKER.md'))
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal((readSent().match(/\[Room wake/g) || []).length, 1, readSent())
      const after = readResidents()['ev-shop'].caretaker
      assert.ok(after.nextWakeAtMs > Date.now() + 800_000)
      assert.ok(Number.isFinite(Date.parse(after.lastWakeAt)))
      assert.equal(readMeta()[caretakerId].ralph.enabled, true)

      // A resident whose OMP died before writing a session file is started fresh.
      const shortCaretaker = `feather-${caretakerId.slice(0, 8)}`
      fs.writeFileSync(tmuxReg, fs.readFileSync(tmuxReg, 'utf8').split('\n').filter(name => name && name !== shortCaretaker).join('\n') + '\n')
      const wokenOnce = readResidents()['ev-shop']
      fs.writeFileSync(path.join(home, '.feather/room-residents.json'), JSON.stringify({
        'ev-shop': { ...wokenOnce, caretaker: { ...wokenOnce.caretaker, nextWakeAtMs: 1 } },
      }))
      await waitFor(() => (readSent().match(/\[Room wake · #ev-shop · caretaker/g) || []).length === 2 || null, { message: 'caretaker relaunch wake' })
      assert.ok(fs.readFileSync(tmuxReg, 'utf8').split('\n').includes(shortCaretaker), 'caretaker relaunched in tmux')

      // A Ralph resident that is mid-turn is left alone until it finishes;
      // one that said RALPH_COMPLETE is woken again when its slot comes up.
      const busy = readResidents()['ev-shop']
      const updaterSessionId = busy.updater.sessionId
      const setUpdaterRalph = (patch) => {
        const current = readMeta()
        current[updaterSessionId].ralph = { ...current[updaterSessionId].ralph, ...patch }
        fs.writeFileSync(path.join(stateDir, 'session-meta.json'), JSON.stringify(current))
      }
      setUpdaterRalph({ enabled: true, status: 'working' })
      fs.writeFileSync(path.join(home, '.feather/room-residents.json'), JSON.stringify({
        'ev-shop': { ...busy, updater: { ...busy.updater, nextWakeAtMs: Date.now() - 1_000 } },
      }))
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal((readSent().match(/\[Room wake · #ev-shop · updater/g) || []).length, 0, readSent())
      setUpdaterRalph({ enabled: false, status: 'complete' })
      await waitFor(() => readSent().includes('[Room wake · #ev-shop · updater') ? readSent() : null, { message: 'updater wake after RALPH_COMPLETE' })
      assert.equal(readMeta()[updaterSessionId].ralph.enabled, true)
      assert.ok(readResidents()['ev-shop'].updater.nextWakeAtMs > Date.now() + 1_700_000)
      // A turn that never ends does not silence the resident: a whole interval
      // past due, the wake is sent anyway.
      setUpdaterRalph({ enabled: true, status: 'working' })
      const stuck = readResidents()['ev-shop']
      fs.writeFileSync(path.join(home, '.feather/room-residents.json'), JSON.stringify({
        'ev-shop': { ...stuck, updater: { ...stuck.updater, nextWakeAtMs: Date.now() - 1_800_000 - 1_000 } },
      }))
      await waitFor(() => (readSent().match(/\[Room wake · #ev-shop · updater/g) || []).length === 2 || null, { message: 'overdue updater wake' })

      // Pausing the Room's residents stops scheduled wakes without touching
      // their chats; resuming re-arms the schedule from now.
      const pausedResponse = await fetch(`${base}/api/rooms/ev-shop/residents/pause`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: true }),
      })
      assert.equal(pausedResponse.status, 200, await pausedResponse.text())
      assert.ok(Object.values(readResidents()['ev-shop']).every(resident => resident.paused === true))
      const pausedSnapshot = await (await fetch(`${base}/api/rooms/ev-shop/residents`)).json()
      assert.ok(pausedSnapshot.residents.filter(resident => resident.role !== 'leader').every(resident => resident.paused === true))
      const wakesBeforePause = (readSent().match(/\[Room wake/g) || []).length
      const pausedState = readResidents()['ev-shop']
      fs.writeFileSync(path.join(home, '.feather/room-residents.json'), JSON.stringify({
        'ev-shop': { ...pausedState, caretaker: { ...pausedState.caretaker, nextWakeAtMs: 1 } },
      }))
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal((readSent().match(/\[Room wake/g) || []).length, wakesBeforePause, 'no wakes while paused')
      const resumed = await fetch(`${base}/api/rooms/ev-shop/residents/pause`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: false }),
      })
      assert.equal(resumed.status, 200)
      const resumedCaretaker = readResidents()['ev-shop'].caretaker
      assert.equal(resumedCaretaker.paused, false)
      assert.ok(resumedCaretaker.nextWakeAtMs > Date.now() + 800_000, 'resume re-arms from now')
      const badPause = await fetch(`${base}/api/rooms/ev-shop/residents/pause`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: 'yes' }),
      })
      assert.equal(badPause.status, 400)

      // Feed comments: publish one card as the updater, then comment on it.
      const updaterId = updaterSessionId
      fs.writeFileSync(path.join(roomDir, 'artifacts/plan.png'),
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
      const token = fs.readFileSync(path.join(home, '.feather/omp-sessions/.feather-bridge-tokens', createHash('sha256').update(updaterId).digest('hex')), 'utf8')
      const published = await fetch(`${base}/api/internal/rooms/ev-shop/publications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Feather-Session-ID': updaterId, 'X-Feather-Bridge-Token': token },
        body: JSON.stringify({
          id: 'plan-001', sourceEvidenceId: 'wiki/Plan.md', title: 'EV shop business plan',
          summary: 'Eleven bays at 815 3rd St pencil out at year two.', visual: 'artifacts/plan.png', visualAlt: 'A plan card.',
        }),
      })
      const publishedText = await published.text()
      assert.equal(published.status, 201, publishedText)
      const feed = await (await fetch(`${base}/api/feed`)).json()
      const card = feed.items.find(item => item.evidenceId === 'publication:ev-shop:plan-001')
      assert.deepEqual(card.comments, [])

      const rejected = await fetch(`${base}/api/feed/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evidenceId: 'publication:ev-shop:missing', text: 'hello' }),
      })
      assert.equal(rejected.status, 404)
      const commented = await fetch(`${base}/api/feed/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evidenceId: card.evidenceId, text: 'What rent did you assume?' }),
      })
      const commentedText = await commented.text()
      assert.equal(commented.status, 201, commentedText)
      const { comment } = JSON.parse(commentedText)
      assert.match(comment.id, /^[0-9a-f]{32}$/)
      assert.equal(comment.room, 'ev-shop')
      assert.equal(comment.reply, null)
      const sent = readSent()
      assert.ok(sent.includes(`[Super Feed comment · #ev-shop] [feed-comment:${comment.id}]`))
      assert.ok(sent.includes('What rent did you assume?'))
      assert.ok(sent.includes('Card: #ev-shop · EV shop business plan'))
      const stored = JSON.parse(fs.readFileSync(path.join(stateDir, 'feed-comments.json'), 'utf8'))
      assert.equal(stored.comments[0].leaderSessionId, room.leaderSessionId)
      const refreshed = await (await fetch(`${base}/api/feed`)).json()
      const withComment = refreshed.items.find(item => item.evidenceId === card.evidenceId)
      assert.equal(withComment.comments.length, 1)
      assert.equal(withComment.comments[0].text, 'What rent did you assume?')
      assert.ok(!('leaderSessionId' in withComment.comments[0]))
      // The comment itself never shows up as a Leader-message card.
      assert.ok(!JSON.stringify(refreshed).includes('[Super Feed comment'))
    } finally {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
