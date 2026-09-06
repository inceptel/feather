// Local usage ledger: every harness on this box writes a transcript that
// carries token usage per assistant turn. Feather reads those transcripts
// (Claude Code, OMP, Codex) into one event stream so the Costs tab can show
// tokens and spend per model, per Room, and per session without asking any
// provider. Files are re-read only when their size or mtime changes.

import fs from 'fs'
import path from 'path'

export const USAGE_WINDOWS = [
  { key: '5h', label: 'Last 5 hours', ms: 5 * 3_600_000 },
  { key: '24h', label: 'Last 24 hours', ms: 24 * 3_600_000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
]

const nonNegative = (value) => (Number.isFinite(value) && value > 0 ? value : 0)

export function roomForCwd(cwd, roomsDir) {
  if (typeof cwd !== 'string' || !roomsDir) return null
  const relative = path.relative(roomsDir, cwd)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  const [name] = relative.split(path.sep)
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? name : null
}

function makeEvent({ at, harness, provider, model, sessionId, cwd, room, input, output, cacheRead, cacheWrite, cost }) {
  return {
    at,
    harness,
    provider: provider || null,
    model: model || 'unknown',
    sessionId: sessionId || null,
    cwd: cwd || null,
    room: room || null,
    input: nonNegative(input),
    output: nonNegative(output),
    cacheRead: nonNegative(cacheRead),
    cacheWrite: nonNegative(cacheWrite),
    cost: Number.isFinite(cost) ? cost : null,
  }
}

// Claude Code: one JSON line per assistant chunk. Streaming writes the same
// message (same message.id) several times with identical usage, so the last
// line per id wins.
export function parseClaudeTranscript(text, { sessionId = null, roomsDir = null } = {}) {
  const byId = new Map()
  let order = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry?.type !== 'assistant') continue
    const message = entry.message
    const usage = message?.usage
    if (!usage || typeof usage !== 'object') continue
    if (typeof message.model !== 'string' || message.model.startsWith('<')) continue
    const at = Date.parse(entry.timestamp)
    if (!Number.isFinite(at)) continue
    const id = typeof message.id === 'string' ? message.id : `line-${order}`
    order++
    byId.set(id, makeEvent({
      at,
      harness: 'claude',
      provider: 'anthropic',
      model: message.model,
      sessionId: entry.sessionId || sessionId,
      cwd: entry.cwd,
      room: roomForCwd(entry.cwd, roomsDir),
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      cost: null,
    }))
  }
  return [...byId.values()]
}

// OMP: a "session" header carries the cwd; each assistant "message" carries
// model, provider, and usage with the harness's own cost estimate.
export function parseOmpTranscript(text, { sessionId = null, roomsDir = null, room = null } = {}) {
  const events = []
  let cwd = null
  for (const line of text.split('\n')) {
    if (!line) continue
    if (!cwd && line.includes('"session"')) {
      try {
        const head = JSON.parse(line)
        if (head?.type === 'session' && typeof head.cwd === 'string') { cwd = head.cwd; continue }
      } catch { /* fall through to usage parsing */ }
    }
    if (!line.includes('"usage"')) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry?.type !== 'message') continue
    const message = entry.message
    const usage = message?.usage
    if (!usage || typeof usage !== 'object') continue
    if (message.role && message.role !== 'assistant') continue
    const at = Date.parse(entry.timestamp)
    if (!Number.isFinite(at)) continue
    events.push(makeEvent({
      at,
      harness: 'omp',
      provider: message.provider,
      model: message.model,
      sessionId,
      cwd,
      room: room || roomForCwd(cwd, roomsDir),
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: usage.cost && Number.isFinite(usage.cost.total) ? usage.cost.total : null,
    }))
  }
  return events
}

// Codex rollouts: token_count events carry cumulative totals for the session
// plus the account's rate limits. Turn usage is the delta between totals;
// the first event, or a reset, falls back to last_token_usage.
export function parseCodexTranscript(text, { roomsDir = null } = {}) {
  const events = []
  let cwd = null
  let sessionId = null
  let model = null
  let previous = null
  let rateLimits = null
  for (const line of text.split('\n')) {
    if (!line) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const payload = entry?.payload
    if (!payload || typeof payload !== 'object') continue
    if (entry.type === 'session_meta') {
      if (typeof payload.cwd === 'string') cwd = payload.cwd
      if (typeof payload.id === 'string') sessionId = payload.id
      continue
    }
    if (entry.type === 'turn_context') {
      if (typeof payload.cwd === 'string') cwd = payload.cwd
      if (typeof payload.model === 'string') model = payload.model
      continue
    }
    if (entry.type !== 'event_msg' || payload.type !== 'token_count') continue
    const at = Date.parse(entry.timestamp)
    if (!Number.isFinite(at)) continue
    const total = payload.info?.total_token_usage
    const last = payload.info?.last_token_usage
    let usage = null
    if (total && typeof total === 'object') {
      if (previous && total.total_tokens >= previous.total_tokens) {
        usage = {
          input_tokens: total.input_tokens - previous.input_tokens,
          cached_input_tokens: total.cached_input_tokens - previous.cached_input_tokens,
          cache_write_input_tokens: (total.cache_write_input_tokens || 0) - (previous.cache_write_input_tokens || 0),
          output_tokens: total.output_tokens - previous.output_tokens,
        }
      } else usage = last || total
      previous = total
    } else if (last && typeof last === 'object') usage = last
    if (payload.rate_limits && typeof payload.rate_limits === 'object') rateLimits = { at, ...payload.rate_limits }
    if (!usage) continue
    const input = nonNegative(usage.input_tokens)
    const cacheRead = nonNegative(usage.cached_input_tokens)
    const output = nonNegative(usage.output_tokens)
    if (input + output + cacheRead === 0) continue
    events.push(makeEvent({
      at,
      harness: 'codex',
      provider: 'openai-codex',
      model,
      sessionId,
      cwd,
      room: roomForCwd(cwd, roomsDir),
      // Codex counts cached tokens inside input_tokens; split them out so the
      // columns mean the same thing across harnesses.
      input: Math.max(0, input - cacheRead),
      output,
      cacheRead,
      cacheWrite: usage.cache_write_input_tokens,
      cost: null,
    }))
  }
  return { events, rateLimits }
}

function walkFiles(root, { minMtimeMs, maxDepth = 6 }) {
  const out = []
  if (!root || !fs.existsSync(root)) return out
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth && !entry.name.startsWith('.')) stack.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      let stat
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.mtimeMs < minMtimeMs) continue
      out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  return out
}

// One ledger per server: remembers parsed events per file so a scan only
// re-reads transcripts that grew since last time.
export function createUsageLedger({
  claudeProjectsDir,
  ompSessionsDir,
  codexSessionsDir,
  roomsDir,
  readAssignments = () => ({}),
  retentionMs = 8 * 86_400_000,
  now = Date.now,
} = {}) {
  const cache = new Map()

  function parseFile(file, harness, assignments) {
    const cached = cache.get(file.path)
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return cached
    let text
    try { text = fs.readFileSync(file.path, 'utf8') } catch { return { events: [], rateLimits: null } }
    let parsed
    if (harness === 'claude') {
      const sessionId = path.basename(file.path, '.jsonl')
      parsed = { events: parseClaudeTranscript(text, { sessionId, roomsDir }), rateLimits: null }
    } else if (harness === 'omp') {
      const sessionId = path.basename(path.dirname(file.path))
      const room = assignments[sessionId] || null
      parsed = { events: parseOmpTranscript(text, { sessionId, roomsDir, room }), rateLimits: null }
    } else {
      parsed = parseCodexTranscript(text, { roomsDir })
    }
    const record = { size: file.size, mtimeMs: file.mtimeMs, ...parsed }
    cache.set(file.path, record)
    return record
  }

  function scan() {
    const at = now()
    const minMtimeMs = at - retentionMs
    const assignments = readAssignments() || {}
    const events = []
    let codexRateLimits = null
    let files = 0
    const sources = [
      ['claude', claudeProjectsDir, 3],
      ['omp', ompSessionsDir, 3],
      ['codex', codexSessionsDir, 5],
    ]
    const seen = new Set()
    for (const [harness, root, maxDepth] of sources) {
      for (const file of walkFiles(root, { minMtimeMs, maxDepth })) {
        seen.add(file.path)
        files++
        const record = parseFile(file, harness, assignments)
        for (const event of record.events) if (event.at >= minMtimeMs) events.push(event)
        if (record.rateLimits && (!codexRateLimits || record.rateLimits.at > codexRateLimits.at)) codexRateLimits = record.rateLimits
      }
    }
    for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key)
    events.sort((a, b) => a.at - b.at)
    return { events, codexRateLimits, files, scannedAt: at }
  }

  return { scan, cacheSize: () => cache.size }
}

function emptyTotals() {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costedRequests: 0 }
}

function add(totals, event) {
  totals.requests++
  totals.input += event.input
  totals.output += event.output
  totals.cacheRead += event.cacheRead
  totals.cacheWrite += event.cacheWrite
  if (event.cost !== null) { totals.cost += event.cost; totals.costedRequests++ }
  return totals
}

function group(events, keyOf, describe) {
  const groups = new Map()
  for (const event of events) {
    const key = keyOf(event)
    let entry = groups.get(key)
    if (!entry) { entry = { ...describe(event), ...emptyTotals(), lastAt: 0 }; groups.set(key, entry) }
    add(entry, event)
    if (event.at > entry.lastAt) entry.lastAt = event.at
  }
  return [...groups.values()].sort((a, b) => (b.input + b.output + b.cacheRead + b.cacheWrite) - (a.input + a.output + a.cacheRead + a.cacheWrite))
}

export function summarizeUsage(events, { now = Date.now(), topSessions = 12 } = {}) {
  return USAGE_WINDOWS.map((window) => {
    const since = now - window.ms
    const inWindow = events.filter((event) => event.at >= since && event.at <= now + 60_000)
    const totals = inWindow.reduce(add, emptyTotals())
    return {
      key: window.key,
      label: window.label,
      since: new Date(since).toISOString(),
      totals,
      byModel: group(inWindow, (e) => `${e.harness}|${e.provider}|${e.model}`, (e) => ({ model: e.model, provider: e.provider, harness: e.harness })),
      byRoom: group(inWindow, (e) => e.room || '', (e) => ({ room: e.room })),
      bySession: group(inWindow, (e) => `${e.harness}|${e.sessionId}`, (e) => ({ sessionId: e.sessionId, harness: e.harness, room: e.room, model: e.model }))
        .slice(0, topSessions),
      byHarness: group(inWindow, (e) => e.harness, (e) => ({ harness: e.harness })),
    }
  })
}
