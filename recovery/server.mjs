// Standalone: Node builtins only; never import Feather or contact its backend.
// RPC reference: can1357/oh-my-pi packages/coding-agent/src/modes/rpc/
// rpc-mode.ts, rpc-types.ts, rpc-frame.ts and rpc-session-events.ts.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, open, rename } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const origin = process.env.RECOVERY_ORIGIN
const account = process.env.RECOVERY_USER
if (!origin || !/^https?:\/\//.test(origin) || new URL(origin).origin !== origin || !account) throw new Error('Set exact HTTP(S) RECOVERY_ORIGIN and RECOVERY_USER')
const stateDir = process.env.RECOVERY_STATE_DIR
if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('RECOVERY_STATE_DIR must be absolute')
const turnsDir = path.join(stateDir, 'turns')
const sessionsDir = path.join(stateDir, 'sessions')
const port = Number(process.env.RECOVERY_PORT || 4881)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RECOVERY_PORT must be 1–65535')
const model = process.env.RECOVERY_MODEL
const thinking = process.env.RECOVERY_THINKING
if (!model?.trim() || !thinking?.trim()) throw new Error('Set RECOVERY_MODEL and RECOVERY_THINKING for the installed OMP provider')
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_BODY = 40 * 1024
const MAX_TEXT = 1024 * 1024
const PAGE_TEXT = 16 * 1024
const assets = new Map(await Promise.all(['index.html', 'app.js', 'style.css'].map(async name => [name, await readFile(path.join(root, name))])))
let active = null
let child = null
let launching = null
let storageError = false
let stopping = false
let settledProtocol = false
let mutation = Promise.resolve()
let disk = Promise.resolve()
const files = new Map()
const pending = new Map()
let stopTimer

function serial(fn) {
  const task = mutation.then(fn)
  mutation = task.catch(() => {})
  return task
}

// fsync before acknowledging acceptance or completion. Rename prevents torn JSON.
function atomic(file, value) {
  const data = JSON.stringify(value)
  const task = disk.then(async () => {
    const tmp = `${file}.tmp`
    const handle = await open(tmp, 'w', 0o600)
    try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
    await rename(tmp, file)
    const directory = await open(path.dirname(file), 'r')
    try { await directory.sync() } finally { await directory.close() }
  })
  disk = task.catch(() => { storageError = true })
  return task
}

function save(turn) {
  return atomic(path.join(turnsDir, files.get(turn.id)), turn)
}

async function load(id) {
  if (active?.id === id) return active
  const file = files.get(id)
  if (!file) return null
  return JSON.parse(await readFile(path.join(turnsDir, file), 'utf8'))
}

const initialized = (async () => {
  await mkdir(turnsDir, { recursive: true, mode: 0o700 })
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 })
  for (const name of await readdir(turnsDir)) {
    const match = /^(\d{13})-([0-9a-f-]{36})\.json$/.exec(name)
    if (match && ID.test(match[2])) files.set(match[2], name)
  }
  // Only one request may be in flight. Inspect all receipts, since a crash may
  // happen between its acceptance and updating any separate "active" pointer.
  for (const id of files.keys()) {
    const turn = await load(id)
    if (turn.status === 'working' || turn.status === 'stopping') {
      turn.status = 'interrupted'
      turn.error = 'Recovery service restarted during this request. Saved output is shown; execution may have occurred. It was NOT sent again. Ask a new question to inspect the result.'
      await save(turn)
    }
  }
})().catch(() => { storageError = true })

function killAgent(proc = child) {
  if (!proc?.pid) return
  try { process.kill(-proc.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
}

async function finish(status, error = '') {
  if (!active) return
  const turn = active
  turn.status = status
  turn.error = error
  await save(turn)
  if (active === turn) active = null
  clearTimeout(stopTimer)
}

function rpc(type, extra = {}, timeout = 30000) {
  const proc = child
  if (!proc || !proc.stdin.writable) return Promise.reject(new Error('Agent unavailable'))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Agent command timed out')) }, timeout)
    pending.set(id, { resolve, reject, timer })
    const frame = JSON.stringify({ type, id, ...extra }) + '\n'
    // At most one prompt and a handful of control frames are outstanding.
    if (proc.stdin.writableLength + Buffer.byteLength(frame) > 128 * 1024) {
      clearTimeout(timer); pending.delete(id); reject(new Error('Agent input busy')); return
    }
    proc.stdin.write(frame, error => {
      if (!error) return
      clearTimeout(timer); pending.delete(id); reject(error)
    })
  })
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n')
}

async function appendText(text) {
  if (!active || !text) return
  const separator = active.assistant ? '\n\n' : ''
  const remaining = MAX_TEXT - active.assistant.length
  const addition = separator + text
  active.assistant += addition.slice(0, Math.max(0, remaining))
  if (addition.length > remaining) active.truncated = true
  await save(active)
}

async function frameReceived(frame) {
  if (frame.type === 'response') {
    const request = pending.get(frame.id)
    if (request) {
      pending.delete(frame.id); clearTimeout(request.timer)
      if (frame.success) request.resolve(frame.data)
      else request.reject(new Error('OMP rejected the command; check its local configuration and credentials'))
    } else if (frame.command === 'prompt' && frame.id === active?.rpcId && frame.success === false) {
      // 18.1.10 reports asynchronous setup failure as a second response.
      killAgent()
      await finish('error', 'OMP failed after accepting this request. Check its local credentials and provider configuration. This request was NOT resent.')
    }
    return
  }
  if (frame.type === 'rpc_frame_error') throw new Error('OMP output exceeded its frame limit')
  if (!active) return
  if (frame.type === 'message_end' && frame.message?.role === 'assistant') {
    await appendText(textOf(frame.message))
    active.providerFailed = frame.message.stopReason === 'error'
    active.assistantStopReason = frame.message.stopReason
  } else if (frame.type === 'command_output') {
    await appendText(typeof frame.text === 'string' ? frame.text : '')
  } else if (frame.type === 'prompt_result' && frame.id === active.rpcId) {
    // A prompt_result can precede background work; retain the occupied slot.
    active.result = frame.status || (frame.agentInvoked === false ? 'completed' : undefined)
    if (active.result && frame.sessionSettled !== false) await settle()
  } else if (frame.type === 'session_settled' && active.result) {
    await settle()
  } else if (!settledProtocol && frame.type === 'agent_end' && frame.isTerminal === true) {
    // 18.1.10 defers this marked event until prompt unwind, retries,
    // compaction, queued messages and pending async wakes settle. An unmarked
    // or nonterminal agent_end is NEVER sufficient to release the prompt slot.
    active.result = active.status === 'stopping' || active.assistantStopReason === 'aborted' ? 'aborted' : 'completed'
    await settle()
  }
}

async function settle() {
  const result = active.result
  const failed = result === 'error' || active.providerFailed
  await finish(failed ? 'error' : result === 'aborted' ? 'stopped' : 'completed', failed ? 'OMP could not complete this request. Check the account credentials or provider availability; no automatic resend was made.' : '')
}

async function readFrames(proc) {
  let buffer = Buffer.alloc(0)
  for await (const chunk of proc.stdout) {
    buffer = Buffer.concat([buffer, chunk])
    let newline
    while ((newline = buffer.indexOf(10)) !== -1) {
      if (newline > 1024 * 1024) throw new Error('RPC frame too large')
      const line = buffer.subarray(0, newline).toString('utf8')
      buffer = buffer.subarray(newline + 1)
      // Serialize receipt changes with HTTP mutations, including Stop. RPC
      // acknowledgements are never awaited while holding this queue.
      if (line.trim()) await serial(() => frameReceived(JSON.parse(line)))
    }
    if (buffer.length > 1024 * 1024) throw new Error('RPC frame too large')
  }
  if (buffer.length) throw new Error('Incomplete RPC frame')
}

async function ensureAgent() {
  if (launching) return launching
  if (child) return
  launching = (async () => {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/^(FEATHER_|OMP_|PI_|RECOVERY_)/.test(key)) delete env[key]
    }
    const args = ['--mode', 'rpc', '--session-dir', sessionsDir, '--continue', '--no-extensions', '--no-skills', '--no-rules', '--no-title', '--allow-home', '--thinking', thinking,
      '--append-system-prompt', 'This is the independent emergency recovery chat. Act only on the human prompts in this chat. You may diagnose and repair the host when requested. Never automatically repair or restart services. Do not expose credentials in replies. The normal Feather backend may be unavailable; do not depend on it.']
    if (model) args.push('--model', model)
    const proc = spawn(process.env.RECOVERY_OMP_BIN || 'omp', args, {
      cwd: process.env.RECOVERY_CWD || process.env.HOME,
      env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    })
    child = proc
    // Never relay stderr, provider metadata, tool payloads or get_state to HTTP.
    proc.stderr.resume()
    proc.stdin.on('error', () => {})
    const exit = new Promise(resolve => {
      proc.once('error', resolve)
      proc.once('exit', resolve)
    })
    const reader = readFrames(proc)
    void (async () => {
      let problem = false
      try { await reader } catch { problem = true; killAgent(proc) }
      await exit
      if (child !== proc) return
      child = null
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Agent exited')) }
      pending.clear()
      await serial(async () => {
        if (active) await finish('interrupted', problem ? 'The agent output stream failed. Saved output is shown. This request was NOT resent.' : 'The agent exited before completion. Saved output is shown. This request was NOT resent.')
      })
    })().catch(() => { storageError = true })
    try {
      const state = await rpc('get_state', {}, 45000)
      if (!state?.sessionFile || !path.resolve(state.sessionFile).startsWith(sessionsDir + path.sep)) throw new Error('Agent session escaped recovery directory')
      // 18.1.10 uses agent_end.isTerminal; newer OMP uses correlated
      // prompt_result/session_settled. Both distinguish async scheduling pauses.
      settledProtocol = typeof state.isSettled === 'boolean'
    } catch (error) { killAgent(proc); throw error }
  })()
  try { await launching } finally { launching = null }
}

async function execute(turn) {
  try {
    await ensureAgent()
    if (active !== turn || turn.status !== 'working') return
    // Separate browser receipt id from RPC correlation; persist before delivery.
    turn.rpcId = randomUUID()
    await save(turn)
    if (active !== turn || turn.status !== 'working') return
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(turn.rpcId); reject(new Error('Prompt acknowledgement timed out')) }, 45000)
      pending.set(turn.rpcId, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ type: 'prompt', id: turn.rpcId, message: turn.user }) + '\n', error => {
        if (error) { clearTimeout(timer); pending.delete(turn.rpcId); reject(error) }
      })
    })
    if (!settledProtocol && result?.agentInvoked === false) await serial(async () => {
      if (active === turn) await finish('completed')
    })
  } catch {
    killAgent()
    await serial(async () => {
      if (active === turn) await finish('error', 'The recovery agent could not start or acknowledge the request. Check installed OMP, credentials and recovery service configuration. Execution may have begun; this request was NOT resent.')
    })
  }
}

function publicTurn(turn, offset = 0) {
  return {
    id: turn.id, created: turn.created, user: turn.user, status: turn.status,
    assistant: turn.assistant.slice(offset, offset + PAGE_TEXT), offset, length: turn.assistant.length,
    next: offset + PAGE_TEXT < turn.assistant.length ? offset + PAGE_TEXT : null,
    error: turn.error || '', truncated: !!turn.truncated,
  }
}

function reply(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('JSON required'), { status: 415 })
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw Object.assign(new Error('Unsupported encoding'), { status: 415 })
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }) }
}

const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
  res.setTimeout(15000, () => res.destroy())
  try {
    // Bind loopback AND require the authenticating proxy's identity. The proxy
    // must overwrite Remote-User, not preserve an incoming client header.
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers['remote-user'] !== account) return reply(res, 403, { error: 'Forbidden' })
    if (req.headers.origin && req.headers.origin !== origin) return reply(res, 403, { error: 'Origin rejected' })
    if (req.method === 'POST' && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return reply(res, 403, { error: 'Cross-site request rejected' })
    const url = new URL(req.url, origin)
    if (url.pathname === '/recovery' && req.method === 'GET') { res.writeHead(308, { Location: '/recovery/' }); res.end(); return }
    const asset = url.pathname === '/recovery/' ? 'index.html' : url.pathname.slice('/recovery/'.length)
    if (req.method === 'GET' && url.pathname.startsWith('/recovery/') && assets.has(asset)) {
      const type = { 'index.html': 'text/html', 'app.js': 'text/javascript', 'style.css': 'text/css' }[asset]
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Length': assets.get(asset).length })
      res.end(assets.get(asset)); return
    }
    await initialized
    if (req.method === 'GET' && url.pathname === '/recovery/api/state') {
      const before = url.searchParams.get('before') || '\uffff'
      const ordered = [...files.entries()].filter(([, file]) => file < before).sort((a, b) => b[1].localeCompare(a[1]))
      const selected = ordered.slice(0, 10)
      const turns = []
      for (const [id] of selected.reverse()) turns.push(publicTurn(await load(id)))
      return reply(res, 200, { turns, activeId: active?.id || null, storageError, more: ordered.length > 10 ? selected[0][1] : null })
    }
    const match = /^\/recovery\/api\/turn\/([0-9a-f-]+)$/.exec(url.pathname)
    if (req.method === 'GET' && match && ID.test(match[1])) {
      const turn = await load(match[1])
      const offset = Number(url.searchParams.get('offset') || 0)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_TEXT) return reply(res, 400, { error: 'Invalid offset' })
      return turn ? reply(res, 200, publicTurn(turn, offset)) : reply(res, 404, { error: 'Unknown request' })
    }
    if (req.method !== 'POST' || !['/recovery/api/send', '/recovery/api/stop'].includes(url.pathname)) return reply(res, 404, { error: 'Not found' })
    if (req.headers.origin !== origin) return reply(res, 403, { error: 'Exact Origin required' })
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) return reply(res, 413, { error: 'Request too large' })
    const body = await jsonBody(req)
    if (!body || !ID.test(body.id)) return reply(res, 400, { error: 'Valid request id required' })
    await serial(async () => {
      if (storageError || stopping) return reply(res, 503, { error: 'Recovery storage unavailable; no request was accepted' })
      if (url.pathname.endsWith('/send')) {
        if (typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text) > 32 * 1024) return reply(res, 400, { error: 'Message must be 1–32768 UTF-8 bytes' })
        const previous = await load(body.id)
        if (previous) return previous.user === body.text ? reply(res, 200, publicTurn(previous)) : reply(res, 409, { error: 'Request id already used for different text' })
        if (active) return reply(res, 409, { error: 'A request is already running' })
        const turn = { id: body.id, created: Date.now(), user: body.text, assistant: '', status: 'working', error: '' }
        files.set(turn.id, `${turn.created}-${turn.id}.json`)
        await save(turn)
        active = turn
        reply(res, 202, publicTurn(turn))
        void execute(turn)
      } else {
        if (!active || active.id !== body.id) return reply(res, 200, { stopped: true })
        active.status = 'stopping'
        await save(active)
        reply(res, 202, { stopped: false })
        const turn = active
        clearTimeout(stopTimer)
        stopTimer = setTimeout(() => {
          killAgent()
          void serial(async () => { if (active === turn) await finish('stopped', 'Agent was forcibly stopped after the abort deadline. Some work may have completed.') }).catch(() => { storageError = true })
        }, 8000)
        if (child && !launching) void rpc('abort', {}, 7000).catch(() => {})
      }
    })
  } catch (error) {
    if (!res.headersSent) reply(res, error.status || 500, { error: error.status ? error.message : 'Recovery request failed; refresh to inspect its durable receipt before retrying' })
    else res.destroy()
  }
})
server.requestTimeout = 15000
server.headersTimeout = 10000
server.keepAliveTimeout = 5000
server.maxConnections = 64
server.listen(port, '127.0.0.1', () => console.log(`Recovery listening on 127.0.0.1:${port}`))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return
  stopping = true
  server.close()
  killAgent()
  void disk.finally(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
})
