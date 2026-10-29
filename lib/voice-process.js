// Feather runs the Voice page server (voice/server.js) as its own child
// process. One service and one deploy carry both, but a Voice crash restarts
// Voice only, and Feather keeps serving.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'

const SCRIPT = path.join('voice', 'server.js')
const sleeper = new Int32Array(new SharedArrayBuffer(4))

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

// A Feather that died hard (SIGKILL, OOM) leaves its Voice child holding the
// port. Stop it, but only when the pid file still names a Voice server.
function stopOrphan(pidFile, waitMs) {
  let pid
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()) } catch { return }
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return
  let cmdline = ''
  try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch { return }
  if (!cmdline.includes(SCRIPT)) return
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
  for (let waited = 0; waited < waitMs && alive(pid); waited += 50) Atomics.wait(sleeper, 0, 0, 50)
}

// Voice and its workers get the user's environment, not Feather's own settings.
function voiceEnv(env, port, featherUrl) {
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('FEATHER_') && key !== 'PORT') out[key] = value
  }
  return { ...out, PORT: String(port), FEATHER_URL: featherUrl }
}

export function startVoiceProcess({
  appDir,
  pidFile,
  port = 4930,
  featherUrl,
  env = process.env,
  log = console,
  backoffMs = [1000, 5000, 30000],
  stableMs = 60_000,
  orphanWaitMs = 3000,
}) {
  const script = path.join(appDir, SCRIPT)
  let child = null
  let stopped = false
  let failures = 0
  let timer = null

  const removePidFile = () => { try { fs.unlinkSync(pidFile) } catch {} }
  const pipe = (stream, write) => {
    readline.createInterface({ input: stream }).on('line', line => write(`[voice] ${line}`))
  }
  const restartLater = (why) => {
    if (stopped) return
    const delay = backoffMs[Math.min(failures++, backoffMs.length - 1)]
    log.error(`[voice] ${why}; restarting in ${delay}ms`)
    timer = setTimeout(start, delay)
    timer.unref?.()
  }

  function start() {
    timer = null
    if (stopped) return
    const startedAt = Date.now()
    // Its own process group, so a stop also reaches the pi workers it spawned.
    const proc = spawn(process.execPath, [script], {
      cwd: path.dirname(script),
      env: voiceEnv(env, port, featherUrl),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = proc
    if (proc.pid) {
      try { fs.writeFileSync(pidFile, `${proc.pid}\n`) } catch (e) { log.error(`[voice] pid file: ${e.message}`) }
    }
    pipe(proc.stdout, line => log.log(line))
    pipe(proc.stderr, line => log.error(line))
    let settled = false
    const settle = (why) => {
      if (settled) return
      settled = true
      if (child === proc) child = null
      removePidFile()
      if (Date.now() - startedAt >= stableMs) failures = 0
      restartLater(why)
    }
    proc.on('error', e => settle(`failed to start: ${e.message}`))
    proc.on('exit', (code, signal) => settle(`exited (${signal || code})`))
  }

  stopOrphan(pidFile, orphanWaitMs)
  start()

  return {
    get pid() { return child?.pid ?? null },
    stop(signal = 'SIGTERM') {
      stopped = true
      if (timer) clearTimeout(timer)
      const pid = child?.pid
      if (pid) {
        try { process.kill(-pid, signal) } catch { try { process.kill(pid, signal) } catch {} }
      }
      removePidFile()
    },
  }
}
