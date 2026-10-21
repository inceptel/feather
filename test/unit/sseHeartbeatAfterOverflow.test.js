import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { freePort } from './freePort.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

describe('SSE heartbeat after a queue overflow', () => {
  it('keeps the server alive when the heartbeat follows an overflow close', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-sse-hb-'))
    const sessionId = `sse-hb-${Date.now()}`
    const projectDir = path.join(root, '.claude', 'projects', 'fixture')
    const sessionPath = path.join(projectDir, `${sessionId}.jsonl`)
    fs.mkdirSync(projectDir, { recursive: true })
    const mk = (uuid, body) => JSON.stringify({
      type: 'user', uuid, timestamp: new Date().toISOString(),
      isSidechain: false, isMeta: false, message: { role: 'user', content: body },
    })
    fs.writeFileSync(sessionPath, `${mk('seed', 'seed')}\n`)

    const port = await freePort()
    const server = spawn(process.execPath, ['server.js'], {
      cwd: REPO_ROOT,
      env: {
        HOME: root, PORT: String(port), PATH: process.env.PATH,
        FEATHER_SCHEDULER: '0', FEATHER_ROOM_AUTONOMY: '0', FEATHER_MIGRATE_TMUX: '0', FEATHER_PUSH_POLL: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    server.stdout.on('data', chunk => { output += chunk })
    server.stderr.on('data', chunk => { output += chunk })
    try {
      let ready = false
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(250) })
          if (response.ok) { ready = true; break }
        } catch {}
        if (server.exitCode !== null) throw new Error(`server exited early\n${output}`)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(ready, true, `server did not start\n${output}`)

      const stalled = new AbortController()
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/stream`, {
        headers: { Accept: 'text/event-stream' }, signal: stalled.signal,
      })
      assert.equal(response.status, 200)
      // Never read response.body: broadcasts pile up in the write queue.
      const filler = 'y'.repeat(64 * 1024)
      for (let index = 0; index < 96; index++) {
        fs.appendFileSync(sessionPath, `${mk(`live-${index}`, `${index} ${filler}`)}\n`)
        await new Promise(resolve => setTimeout(resolve, 15))
      }
      // The 15s heartbeat is the write that lands after the overflow close.
      await new Promise(resolve => setTimeout(resolve, 18000))
      assert.equal(server.exitCode, null, `server died on the post-overflow heartbeat\n${output}`)
      const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
      assert.equal(health.ok, true, output)
      stalled.abort()
    } finally {
      server.kill()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
