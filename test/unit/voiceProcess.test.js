import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { startVoiceProcess } from '../../lib/voice-process.js'

// A stand-in voice/server.js: it records what it was started with, starts a
// worker like the real one does, and runs until it is killed.
const FAKE_VOICE = `
import fs from 'node:fs'
import { spawn } from 'node:child_process'
const worker = spawn('sleep', ['600'], { stdio: 'ignore' })
fs.appendFileSync(process.env.VOICE_TEST_OUT, JSON.stringify({
  pid: process.pid, worker: worker.pid, port: process.env.PORT,
  featherUrl: process.env.FEATHER_URL, featherSecret: process.env.FEATHER_SECRET ?? null,
}) + '\\n')
console.log('voice ready')
setInterval(() => {}, 1000)
`

function fixture() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-voice-'))
  fs.mkdirSync(path.join(appDir, 'voice'))
  fs.writeFileSync(path.join(appDir, 'voice', 'package.json'), '{"type":"module"}')
  fs.writeFileSync(path.join(appDir, 'voice', 'server.js'), FAKE_VOICE)
  const out = path.join(appDir, 'starts.jsonl')
  const lines = []
  const log = { log: line => lines.push(line), error: line => lines.push(line) }
  const env = { ...process.env, VOICE_TEST_OUT: out, FEATHER_SECRET: 'not-for-voice', PORT: '3300' }
  return { appDir, out, lines, log, env, pidFile: path.join(appDir, 'voice.pid') }
}

const starts = out => {
  try { return fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) } catch { return [] }
}
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

async function until(check, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = check()
    if (value) return value
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('timed out')
}

describe('startVoiceProcess', () => {
  it('starts Voice with its own port and Feather URL, without Feather settings', async () => {
    const fx = fixture()
    const voice = startVoiceProcess({ appDir: fx.appDir, pidFile: fx.pidFile, port: 4939, featherUrl: 'http://127.0.0.1:3300', env: fx.env, log: fx.log })
    try {
      const [first] = await until(() => starts(fx.out).length && starts(fx.out))
      assert.equal(first.pid, voice.pid)
      assert.equal(first.port, '4939')
      assert.equal(first.featherUrl, 'http://127.0.0.1:3300')
      assert.equal(first.featherSecret, null)
      assert.equal(fs.readFileSync(fx.pidFile, 'utf8').trim(), String(voice.pid))
      await until(() => fx.lines.includes('[voice] voice ready'))
    } finally { voice.stop() }
  })

  it('restarts Voice after a crash, and a stop ends it and its workers for good', async () => {
    const fx = fixture()
    const voice = startVoiceProcess({ appDir: fx.appDir, pidFile: fx.pidFile, featherUrl: 'http://x', env: fx.env, log: fx.log, backoffMs: [50] })
    try {
      const [first] = await until(() => starts(fx.out).length && starts(fx.out))
      process.kill(first.pid, 'SIGKILL')
      const second = await until(() => starts(fx.out)[1])
      assert.notEqual(second.pid, first.pid)
      assert.equal(voice.pid, second.pid)
      assert.ok(fx.lines.some(line => /exited \(SIGKILL\); restarting in 50ms/.test(line)))
      voice.stop()
      await until(() => !alive(second.pid) && !alive(second.worker))
      await new Promise(r => setTimeout(r, 200))
      assert.equal(starts(fx.out).length, 2)
      assert.equal(fs.existsSync(fx.pidFile), false)
      process.kill(first.worker, 'SIGKILL')
    } finally { voice.stop() }
  })

  it('stops a Voice left behind by a Feather that died hard', async () => {
    const fx = fixture()
    // Not our child, like a real orphan: a dead child would linger as a zombie.
    const script = path.join(fx.appDir, 'voice', 'server.js')
    spawn('sh', ['-c', `setsid "${process.execPath}" "${script}" >/dev/null 2>&1 &`], { env: fx.env, stdio: 'ignore' })
    const left = await until(() => starts(fx.out)[0])
    fs.writeFileSync(fx.pidFile, `${left.pid}\n`)
    const voice = startVoiceProcess({ appDir: fx.appDir, pidFile: fx.pidFile, featherUrl: 'http://x', env: fx.env, log: fx.log })
    try {
      await until(() => !alive(left.pid) && !alive(left.worker))
      const next = await until(() => starts(fx.out)[1])
      assert.equal(next.pid, voice.pid)
    } finally { voice.stop() }
  })

  it('leaves alone a pid file that names some other process', async () => {
    const fx = fixture()
    const other = spawn('sleep', ['600'], { stdio: 'ignore' })
    fs.writeFileSync(fx.pidFile, `${other.pid}\n`)
    const voice = startVoiceProcess({ appDir: fx.appDir, pidFile: fx.pidFile, featherUrl: 'http://x', env: fx.env, log: fx.log })
    try {
      assert.equal(alive(other.pid), true)
    } finally {
      voice.stop()
      other.kill('SIGKILL')
    }
  })
})
