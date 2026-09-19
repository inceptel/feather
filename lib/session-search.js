// Full-text search over session transcripts, backed by a SQLite FTS5 index.
//
// The previous implementation shelled out to grep across every JSONL file on
// each search (hundreds of MB per keystroke). This module indexes the text of
// real user/assistant messages once, then keeps the index fresh by reading
// only the bytes appended since the last sync. A query is a single FTS5 MATCH
// that returns in milliseconds, ranked by BM25, with a snippet per session.
//
// The database is disposable: delete it and the next sync rebuilds it.

import fs from 'fs'
import path from 'path'
import { parseMessageForAgent } from './parse.js'

const SCHEMA_VERSION = 1
const READ_CHUNK = 4 * 1024 * 1024
const MAX_TEXT_PER_MESSAGE = 64 * 1024
const MAX_HITS = 4000

// node:sqlite is stable enough for this use but still emits an
// ExperimentalWarning on import in Node 22. Silence only that one line.
export async function loadSqlite() {
  const original = process.emitWarning
  process.emitWarning = (warning, ...rest) => {
    if (/SQLite is an experimental feature/.test(String(warning?.message || warning))) return
    return original.call(process, warning, ...rest)
  }
  try { return await import('node:sqlite') } finally { process.emitWarning = original }
}

// Text a person would recognise as "what was said": text blocks only. Tool
// calls, tool output, thinking, and JSON keys are deliberately excluded.
export function messageSearchText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim())
  }
  return parts.join('\n').slice(0, MAX_TEXT_PER_MESSAGE)
}

// Turn free text into a safe FTS5 expression: every whitespace-separated
// token becomes a quoted phrase with prefix matching, joined by implicit AND.
// Quoting neutralises FTS5 operators (AND, OR, NOT, NEAR, ^, *, :) so a user
// can type anything without a syntax error.
export function buildMatchExpression(query) {
  const tokens = String(query || '').split(/\s+/).map(t => t.trim()).filter(Boolean)
  const phrases = []
  for (const token of tokens) {
    // unicode61 treats punctuation as separators; keep only token characters
    // so `"search.db"` becomes the phrase `search db`.
    const words = token.split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
    if (words.length === 0) continue
    phrases.push(`"${words.join(' ').replace(/"/g, '""')}"*`)
  }
  return phrases.join(' ')
}

// Split an FTS5 snippet that used \u0001/\u0002 markers into parts.
export function splitSnippet(raw) {
  const parts = []
  const re = /\u0001([\s\S]*?)\u0002/g
  let last = 0
  let m
  while ((m = re.exec(raw))) {
    if (m.index > last) parts.push({ text: raw.slice(last, m.index), match: false })
    parts.push({ text: m[1], match: true })
    last = re.lastIndex
  }
  if (last < raw.length) parts.push({ text: raw.slice(last), match: false })
  return parts.map(p => ({ ...p, text: p.text.replace(/\s+/g, ' ') })).filter(p => p.text)
}

/**
 * createSessionSearch({ dbPath }) → { ready, sync, search, stats, close }
 *
 * - sync(candidates, { signal }) indexes new bytes for each { id, fpath, agent,
 *   size, mtime } and forgets files that are no longer candidates. It yields
 *   to the event loop between chunks so a first backfill does not stall the
 *   server.
 * - search(query, { limit }) returns Map<fpath, { sessionId, snippet, messageId,
 *   role, timestamp, count, rank }> with the best-ranked message per session.
 */
export function createSessionSearch({ dbPath }) {
  let db = null
  let statements = null

  const ready = (async () => {
    const { DatabaseSync } = await loadSqlite()
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    db = openDatabase(DatabaseSync, dbPath)
    statements = prepare(db)
  })()

  function initialise(handle) {
    handle.exec('PRAGMA journal_mode = WAL')
    handle.exec('PRAGMA synchronous = NORMAL')
    const version = handle.prepare('PRAGMA user_version').get().user_version
    if (version === SCHEMA_VERSION) return
    handle.exec(`
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS messages;
      CREATE TABLE files (
        fpath TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        indexed_bytes INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE messages USING fts5(
        text,
        fpath UNINDEXED,
        session_id UNINDEXED,
        uuid UNINDEXED,
        role UNINDEXED,
        ts_ms UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
  }

  function openDatabase(DatabaseSync, file) {
    try {
      const handle = new DatabaseSync(file)
      try { initialise(handle); return handle } catch (error) { try { handle.close() } catch {}; throw error }
    } catch (error) {
      // A corrupt or foreign database is disposable: delete it and rebuild.
      if (file === ':memory:') throw error
      for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(file + suffix) } catch {} }
      const handle = new DatabaseSync(file)
      initialise(handle)
      return handle
    }
  }

  function prepare(handle) {
    return {
      getFile: handle.prepare('SELECT fpath, session_id, agent, size, mtime_ms, indexed_bytes FROM files WHERE fpath = ?'),
      allFiles: handle.prepare('SELECT fpath FROM files'),
      upsertFile: handle.prepare(`INSERT INTO files (fpath, session_id, agent, size, mtime_ms, indexed_bytes) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(fpath) DO UPDATE SET session_id = excluded.session_id, agent = excluded.agent, size = excluded.size, mtime_ms = excluded.mtime_ms, indexed_bytes = excluded.indexed_bytes`),
      deleteFile: handle.prepare('DELETE FROM files WHERE fpath = ?'),
      deleteMessages: handle.prepare('DELETE FROM messages WHERE fpath = ?'),
      insertMessage: handle.prepare('INSERT INTO messages (text, fpath, session_id, uuid, role, ts_ms) VALUES (?, ?, ?, ?, ?, ?)'),
      search: handle.prepare(`SELECT fpath, session_id, uuid, role, ts_ms, bm25(messages) AS rank,
          snippet(messages, 0, char(1), char(2), '…', 14) AS snippet
        FROM messages WHERE messages MATCH ? ORDER BY rank LIMIT ?`),
      countFiles: handle.prepare('SELECT count(*) AS n FROM files'),
      countMessages: handle.prepare('SELECT count(*) AS n FROM messages'),
      begin: handle.prepare('BEGIN'),
      commit: handle.prepare('COMMIT'),
      rollback: handle.prepare('ROLLBACK'),
    }
  }

  // Read [from, size) of a file line by line, calling onLine for each complete
  // line. Works on bytes so a chunk boundary inside a multi-byte character is
  // harmless. Returns the offset just past the last complete line consumed.
  async function readLines(fpath, from, size, onLine, signal) {
    const fd = await fs.promises.open(fpath, 'r')
    try {
      let position = from
      let consumed = from
      let carry = Buffer.alloc(0)
      const buffer = Buffer.allocUnsafe(READ_CHUNK)
      while (position < size) {
        signal?.throwIfAborted()
        const { bytesRead } = await fd.read(buffer, 0, Math.min(READ_CHUNK, size - position), position)
        if (bytesRead === 0) break
        position += bytesRead
        const chunk = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead)
        const lastNewline = chunk.lastIndexOf(10)
        if (lastNewline < 0) { carry = Buffer.from(chunk); continue }
        for (const line of chunk.toString('utf8', 0, lastNewline).split('\n')) if (line) onLine(line)
        carry = Buffer.from(chunk.subarray(lastNewline + 1))
        consumed = position - carry.length
      }
      return consumed
    } finally {
      await fd.close()
    }
  }

  async function indexFile(candidate, existing, signal) {
    const { fpath, id, agent, size } = candidate
    const mtimeMs = candidate.mtime instanceof Date ? candidate.mtime.getTime() : Number(candidate.mtime) || 0
    let from = 0
    const rewritten = !existing || existing.agent !== agent || size < existing.indexed_bytes
    if (!rewritten) from = existing.indexed_bytes
    const rows = []
    const consumed = await readLines(fpath, from, size, (line) => {
      const message = parseMessageForAgent(line, agent)
      if (!message) return
      const text = messageSearchText(message)
      if (!text) return
      const ts = Date.parse(message.timestamp)
      rows.push([text, fpath, id, String(message.uuid || ''), message.role, Number.isNaN(ts) ? 0 : ts])
    }, signal)
    signal?.throwIfAborted()
    statements.begin.run()
    try {
      if (rewritten && existing) statements.deleteMessages.run(fpath)
      for (const row of rows) statements.insertMessage.run(...row)
      statements.upsertFile.run(fpath, id, agent, size, mtimeMs, consumed)
      statements.commit.run()
    } catch (error) {
      statements.rollback.run()
      throw error
    }
    return rows.length
  }

  async function sync(candidates, { signal } = {}) {
    await ready
    const seen = new Set()
    let indexedFiles = 0
    let indexedMessages = 0
    const failures = []
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      if (!candidate?.fpath) continue
      seen.add(candidate.fpath)
      const existing = statements.getFile.get(candidate.fpath) || null
      const mtimeMs = candidate.mtime instanceof Date ? candidate.mtime.getTime() : Number(candidate.mtime) || 0
      if (existing && existing.size === candidate.size && existing.mtime_ms === mtimeMs && existing.agent === candidate.agent && existing.session_id === candidate.id) continue
      if (existing && existing.size === candidate.size && existing.agent === candidate.agent && existing.session_id === candidate.id) {
        // Only mtime moved (idle bookkeeping rewrites in place are rare; a
        // same-size rewrite would be missed, which is acceptable for search).
        statements.upsertFile.run(candidate.fpath, candidate.id, candidate.agent, candidate.size, mtimeMs, existing.indexed_bytes)
        continue
      }
      try {
        indexedMessages += await indexFile(candidate, existing, signal)
        indexedFiles++
      } catch (error) {
        if (signal?.aborted) throw error
        // Unreadable file: drop what we had so a stale index is not served.
        if (error?.code === 'ENOENT') { statements.deleteMessages.run(candidate.fpath); statements.deleteFile.run(candidate.fpath); continue }
        failures.push({ fpath: candidate.fpath, error: error.message })
        if (failures.length <= 3) console.error(`[search] could not index ${candidate.fpath}: ${error.message}`)
      }
    }
    for (const { fpath } of statements.allFiles.all()) {
      if (seen.has(fpath)) continue
      statements.deleteMessages.run(fpath)
      statements.deleteFile.run(fpath)
    }
    return { indexedFiles, indexedMessages, failures }
  }

  function search(query, { limit = MAX_HITS } = {}) {
    if (!db) throw new Error('session search index is not ready')
    const expression = buildMatchExpression(query)
    const results = new Map()
    if (!expression) return results
    let rows
    try { rows = statements.search.all(expression, limit) } catch { return results }
    for (const row of rows) {
      const hit = results.get(row.fpath)
      if (hit) { hit.count++; continue }
      results.set(row.fpath, {
        sessionId: row.session_id,
        messageId: row.uuid || null,
        role: row.role,
        timestamp: row.ts_ms ? new Date(row.ts_ms).toISOString() : null,
        snippet: splitSnippet(row.snippet || ''),
        rank: row.rank,
        count: 1,
      })
    }
    return results
  }

  function stats() {
    if (!db) return { files: 0, messages: 0, ready: false }
    return { files: statements.countFiles.get().n, messages: statements.countMessages.get().n, ready: true }
  }

  function close() {
    if (db) { try { db.close() } catch {} }
    db = null
    statements = null
  }

  return { ready, sync, search, stats, close }
}
