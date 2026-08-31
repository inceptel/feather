import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'

import { encodeProjectPath } from '../../lib/rooms.js'

const roots = []
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }) })

function sessionLine(id, cwd, text) {
  return JSON.stringify({
    type: 'user', uuid: `${id}-message`, cwd, timestamp: new Date().toISOString(),
    isMeta: false, isSidechain: false, message: { role: 'user', content: text },
  }) + '\n'
}

describe('Room status scheduler', () => {
  it('runs beside active work and residents while reporting launch failures', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-pulse-'))
    roots.push(root)
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')
    const binDir = path.join(root, 'bin')
    const tmuxLog = path.join(root, 'tmux.log')
    const activeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const residentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const rooms = ['active', 'resident', 'idle', 'broken']
    fs.mkdirSync(path.join(home, '.feather'), { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })
    for (const name of rooms) {
      const roomDir = path.join(home, 'rooms', name)
      fs.mkdirSync(roomDir, { recursive: true })
      fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), `# Room: #${name}\n`)
      fs.writeFileSync(path.join(roomDir, 'notes.md'), `# #${name} — notes\n`)
    }
    const activeProject = path.join(home, '.claude/projects', encodeProjectPath(path.join(home, 'rooms/active')))
    fs.mkdirSync(activeProject, { recursive: true })
    fs.writeFileSync(path.join(activeProject, `${activeId}.jsonl`), sessionLine(activeId, path.join(home, 'rooms/active'), 'still working'))
    const residentProject = path.join(home, '.claude/projects', encodeProjectPath(path.join(home, 'rooms/resident')))
    fs.mkdirSync(residentProject, { recursive: true })
    fs.writeFileSync(path.join(residentProject, `${residentId}.jsonl`),
      sessionLine(residentId, path.join(home, 'rooms/resident'), 'waiting for resident work'))
    fs.writeFileSync(path.join(home, '.feather/room-residents.json'), JSON.stringify({
      resident: { caretaker: { sessionId: residentId } },
    }))
    const due = (sessionId = null) => ({ enabled: true, status: 'waiting', lastRunAt: null, nextRunAtMs: 1, sessionId, error: null })
    fs.writeFileSync(path.join(home, '.feather/room-pulses.json'), JSON.stringify({ active: due(), resident: due(), idle: due(), broken: due() }))
    fs.writeFileSync(path.join(binDir, 'tmux'), `#!/bin/sh\nif [ "$1" = list-sessions ]; then now="$(date +%s)"; printf 'feather-aaaaaaaa|%s\\nfeather-cccccccc|%s\\n' "$now" "$now"; exit 0; fi\nif [ "$1" = has-session ] && { [ "$3" = feather-aaaaaaaa ] || [ "$3" = feather-cccccccc ]; }; then exit 0; fi\nif [ "$1" = new-session ]; then case "$*" in *rooms/broken*) exit 1;; esac; printf '%s\\n' "$*" >>"$TMUX_TEST_LOG"; exit 0; fi\nif [ "$1" = set-option ]; then exit 0; fi\nexit 1\n`)
    fs.chmodSync(path.join(binDir, 'tmux'), 0o755)

    const port = 29_000 + (process.pid % 1000)
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env, HOME: home, FEATHER_STATE_DIR: stateDir, PORT: String(port),
        FEATHER_ROOM_PULSE_CHECK_MS: '50', FEATHER_ROOM_PULSE_INTERVAL_MS: '60000', FEATHER_ROOM_PULSE_MAX_CONCURRENT: '4',
        PATH: `${binDir}:${process.env.PATH}`, TMUX_TEST_LOG: tmuxLog,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const readLaunches = () => {
      try { return fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').filter(Boolean) } catch { return [] }
    }
    try {
      let state
      for (let attempt = 0; attempt < 100; attempt++) {
        try { state = JSON.parse(fs.readFileSync(path.join(home, '.feather/room-pulses.json'), 'utf8')) } catch {}
        if (state?.active?.status === 'working' && state?.resident?.status === 'working' && state?.idle?.status === 'working' && state?.broken?.status === 'error' && readLaunches().length === 3) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(state?.idle?.status, 'working', stderr)
      assert.equal(state?.resident?.status, 'working', stderr)
      assert.equal(state?.active?.status, 'working', stderr)
      assert.match(state.idle.sessionId, /^[0-9a-f-]{36}$/)
      assert.match(state.active.sessionId, /^[0-9a-f-]{36}$/)
      assert.equal(state.broken.status, 'error')
      assert.match(state.broken.error, /Command failed/)
      const launches = readLaunches()
      assert.equal(launches.length, 3, JSON.stringify({ launches, state }))
      assert.ok(launches.some((launch) => launch.includes('rooms/active')))
      assert.ok(launches.some((launch) => launch.includes('rooms/idle')))
      assert.ok(launches.some((launch) => launch.includes('rooms/resident')))
      assert.ok(launches.every((launch) => /omp .* -p --auto-approve .*pulse\.md/.test(launch)))
      assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.feather/room-sessions.json'), 'utf8'))[state.idle.sessionId], 'idle')
      const prompt = fs.readFileSync(path.join(home, '.feather/omp-sessions', state.active.sessionId, 'pulse.md'), 'utf8')
      assert.match(prompt, /What is everyone working on/)
      assert.match(prompt, /Status collection only/)
      assert.doesNotMatch(prompt, /do the next useful thing/)
      const meta = JSON.parse(fs.readFileSync(path.join(stateDir, 'session-meta.json'), 'utf8'))
      assert.equal(meta[state.active.sessionId].title, 'Status: #active')

    } finally {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })

  it('caps simultaneous status runs and defers the rest of a synchronized batch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-room-pulse-cap-'))
    roots.push(root)
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')
    const binDir = path.join(root, 'bin')
    const tmuxLog = path.join(root, 'tmux.log')
    const tmuxReg = path.join(root, 'tmux.reg')
    const rooms = ['r1', 'r2', 'r3', 'r4', 'r5']
    fs.mkdirSync(path.join(home, '.feather'), { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })
    for (const name of rooms) {
      const roomDir = path.join(home, 'rooms', name)
      fs.mkdirSync(roomDir, { recursive: true })
      fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), `# Room: #${name}\n`)
      fs.writeFileSync(path.join(roomDir, 'notes.md'), `# #${name} — notes\n`)
    }
    const due = () => ({ enabled: true, status: 'waiting', lastRunAt: null, nextRunAtMs: 1, sessionId: null, error: null })
    fs.writeFileSync(path.join(home, '.feather/room-pulses.json'),
      JSON.stringify(Object.fromEntries(rooms.map((name) => [name, due()]))))
    // Mock tmux that registers every launched session as live, so each launch
    // holds a concurrency slot across ticks and the cap is actually exercised.
    fs.writeFileSync(path.join(binDir, 'tmux'), [
      '#!/bin/sh',
      'case "$1" in',
      '  list-sessions) if [ -f "$TMUX_REG" ]; then now=$(date +%s); while IFS= read -r n; do printf "%s|%s\\n" "$n" "$now"; done < "$TMUX_REG"; fi; exit 0 ;;',
      '  has-session) if [ -f "$TMUX_REG" ] && grep -qxF "$3" "$TMUX_REG"; then exit 0; fi; exit 1 ;;',
      '  new-session) name=""; while [ $# -gt 0 ]; do [ "$1" = "-s" ] && name="$2"; shift; done; [ -n "$name" ] && printf "%s\\n" "$name" >> "$TMUX_REG"; printf "launch %s\\n" "$name" >> "$TMUX_TEST_LOG"; exit 0 ;;',
      'esac',
      'exit 0',
    ].join('\n'))
    fs.chmodSync(path.join(binDir, 'tmux'), 0o755)

    const port = 30_000 + (process.pid % 1000)
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...process.env, HOME: home, FEATHER_STATE_DIR: stateDir, PORT: String(port),
        FEATHER_ROOM_PULSE_CHECK_MS: '50', FEATHER_ROOM_PULSE_INTERVAL_MS: '60000',
        FEATHER_ROOM_PULSE_MAX_CONCURRENT: '2',
        PATH: `${binDir}:${process.env.PATH}`, TMUX_TEST_LOG: tmuxLog, TMUX_REG: tmuxReg,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const readState = () => { try { return JSON.parse(fs.readFileSync(path.join(home, '.feather/room-pulses.json'), 'utf8')) } catch { return null } }
    const workingCount = (s) => rooms.filter((n) => s?.[n]?.status === 'working').length
    try {
      let state
      for (let attempt = 0; attempt < 200; attempt++) {
        state = readState()
        if (workingCount(state) >= 2) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      // Let several more ticks pass to prove the cap holds and does not creep up.
      await new Promise((resolve) => setTimeout(resolve, 400))
      state = readState()
      assert.equal(workingCount(state), 2, stderr)
      const launches = fs.readFileSync(tmuxLog, 'utf8').trim().split('\n').filter(Boolean)
      assert.equal(launches.length, 2, `expected 2 launches, got ${launches.length}: ${stderr}`)
      // Oldest-due-then-name ordering picks the alphabetically first two rooms.
      assert.equal(state.r1.status, 'working')
      assert.equal(state.r2.status, 'working')
      for (const name of ['r3', 'r4', 'r5']) assert.equal(state[name].status, 'waiting', `${name} should be deferred`)
    } finally {
      child.kill('SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
})
