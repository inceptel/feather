import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { freePort } from './freePort.js'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { stopChild } from './stopChild.js'

const REPO = path.resolve(import.meta.dirname, '../..')

async function waitFor(predicate, { attempts = 400, delay = 25, message = 'condition' } = {}) {
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
const script = (file, body) => { fs.writeFileSync(file, `#!/bin/sh\n${body}\n`); fs.chmodSync(file, 0o755) }

describe('Scheduler command target', () => {
  it('runs a Room script with no chat, records its outcome and last line, and kills it at the timeout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-scheduler-command-'))
    const home = path.join(root, 'home')
    const stateDir = path.join(root, 'state')
    const binDir = path.join(root, 'bin')
    const roomDir = path.join(home, 'rooms/boat')
    for (const dir of [roomDir, path.join(home, '.feather'), stateDir, path.join(home, '.omp'), binDir]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(home, '.omp/auth-gateway.token'), 'gateway-test-token\n', { mode: 0o600 })
    // No real tmux: a command run must not need one.
    script(path.join(binDir, 'tmux'), 'case "$1" in has-session) exit 1 ;; esac\nexit 0')
    fs.writeFileSync(path.join(roomDir, 'AGENTS.md'), '# boat\n')
    script(path.join(roomDir, 'ok.sh'), 'echo "room=$FEATHER_ROOM rule=$FEATHER_RULE_ID args=$*"\necho "inbox: 1 match, 9 maybe"')
    script(path.join(roomDir, 'fail.sh'), 'echo "Craigslist returned 0 results" >&2\nexit 3')
    script(path.join(roomDir, 'slow.sh'), `echo $$ > "${path.join(root, 'slow.pid')}"\nsleep 30`)
    fs.writeFileSync(path.join(roomDir, 'plain.sh'), 'echo not executable\n')

    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, ['server.js'], {
      cwd: REPO,
      env: {
        ...process.env, HOME: home, FEATHER_STATE_DIR: stateDir, PORT: String(port),
        FEATHER_SCHEDULER_CHECK_MS: '50', FEATHER_SCHEDULER_BOOT_GRACE_MS: '0', FEATHER_ROOM_LEADER_USAGE_CHECK: '0',
        FEATHER_OMP_AUTH_GATEWAY_URL: 'http://127.0.0.1:14000', PATH: `${binDir}:${process.env.PATH}`,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const runsOf = async (ruleId) => (await json(await fetch(`${base}/api/scheduler/runs?limit=200`))).body.runs.filter(run => run.ruleId === ruleId)
    const finished = (ruleId) => waitFor(async () => (await runsOf(ruleId)).find(run => run.event === 'finished'), { message: `${ruleId} finished` })
    try {
      await waitFor(async () => { if (child.exitCode !== null) throw new Error(stderr); try { return (await fetch(`${base}/api/health`)).ok } catch { return false } }, { message: 'health' })

      assert.equal((await put(`${base}/api/scheduler/rules/boat/escape`, { target: { kind: 'command', command: '../x.sh' }, every: '1h' })).status, 400)
      const created = await json(await put(`${base}/api/scheduler/rules/boat/ok`, { target: { kind: 'command', command: 'ok.sh', args: ['--worker', 'outboard'] }, every: '1h' }))
      assert.equal(created.status, 200, created.text)
      assert.equal(created.body.rule?.mode ?? 'fresh', 'fresh')

      assert.equal((await post(`${base}/api/scheduler/rules/boat/ok/fire`)).status, 200)
      const ok = await finished('boat/ok')
      assert.equal(ok.outcome, 'done', JSON.stringify(ok))
      assert.equal(ok.detail, 'inbox: 1 match, 9 maybe')
      assert.equal(ok.sessionId, null, 'no chat was started')
      assert.match(fs.readFileSync(ok.command.logFile, 'utf8'), /room=boat rule=boat\/ok args=--worker outboard/)

      await put(`${base}/api/scheduler/rules/boat/fail`, { target: { kind: 'command', command: 'fail.sh' }, every: '1h' })
      await post(`${base}/api/scheduler/rules/boat/fail/fire`)
      const failed = await finished('boat/fail')
      assert.equal(failed.outcome, 'failed')
      assert.equal(failed.detail, 'exit 3: Craigslist returned 0 results')

      await put(`${base}/api/scheduler/rules/boat/plain`, { target: { kind: 'command', command: 'plain.sh' }, every: '1h' })
      await post(`${base}/api/scheduler/rules/boat/plain/fire`)
      const plain = await finished('boat/plain')
      assert.equal(plain.outcome, 'failed')
      assert.match(plain.detail, /not executable/)

      await put(`${base}/api/scheduler/rules/boat/slow`, { target: { kind: 'command', command: 'slow.sh' }, every: '1h', timeoutMs: '1s' })
      await post(`${base}/api/scheduler/rules/boat/slow/fire`)
      const slow = await finished('boat/slow')
      assert.equal(slow.outcome, 'timeout')
      const pid = Number(fs.readFileSync(path.join(root, 'slow.pid'), 'utf8'))
      await waitFor(() => { try { process.kill(pid, 0); return false } catch { return true } }, { message: 'slow.sh killed' })

      const snapshot = (await json(await fetch(`${base}/api/scheduler?room=boat`))).body
      assert.equal(snapshot.rules.find(rule => rule.id === 'boat/ok').runtime.lastOutcome, 'done')
    } finally {
      await stopChild(child)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
