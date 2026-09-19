// Full-text search over wiki pages, backed by an in-memory SQLite FTS5 table.
//
// The Wiki tab used to filter by page title only. This module indexes the
// text of every shared and Room wiki page so a query like "robinhood fees"
// finds the page that talks about it. The collection is small (low hundreds
// of pages), so the index lives in memory and is rebuilt from scratch on
// each server start; sync() then re-reads only pages whose size or mtime
// changed. Ranking is BM25 with the page name weighted above the body.

import { loadSqlite, buildMatchExpression, splitSnippet } from './session-search.js'

const MAX_RESULTS = 200
const NAME_WEIGHT = 5.0
const TEXT_WEIGHT = 1.0

function pageKey(page) { return `${page.source}\n${page.name}` }

/**
 * createWikiSearch() → { ready, sync, search, stats, close }
 *
 * - sync(pages, read) indexes every { source, name, size, updatedAt } whose
 *   size or updatedAt changed, using read(page) → content string or null, and
 *   forgets pages no longer listed.
 * - search(query, { limit }) → [{ source, name, updatedAt, rank, snippet }]
 *   where snippet is [{ text, match }] parts, best rank first.
 */
export function createWikiSearch() {
  let db = null
  let statements = null

  const ready = (async () => {
    const { DatabaseSync } = await loadSqlite()
    db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE pages (
        key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE page_text USING fts5(
        name,
        text,
        key UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `)
    statements = {
      getPage: db.prepare('SELECT key, size, updated_at FROM pages WHERE key = ?'),
      allKeys: db.prepare('SELECT key FROM pages'),
      upsertPage: db.prepare(`INSERT INTO pages (key, source, name, size, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET source = excluded.source, name = excluded.name, size = excluded.size, updated_at = excluded.updated_at`),
      deletePage: db.prepare('DELETE FROM pages WHERE key = ?'),
      deleteText: db.prepare('DELETE FROM page_text WHERE key = ?'),
      insertText: db.prepare('INSERT INTO page_text (name, text, key) VALUES (?, ?, ?)'),
      search: db.prepare(`SELECT pages.source AS source, pages.name AS name, pages.updated_at AS updatedAt,
          bm25(page_text, ${NAME_WEIGHT}, ${TEXT_WEIGHT}) AS rank,
          snippet(page_text, 1, char(1), char(2), '…', 16) AS snippet
        FROM page_text JOIN pages ON pages.key = page_text.key
        WHERE page_text MATCH ? ORDER BY rank LIMIT ?`),
      countPages: db.prepare('SELECT count(*) AS n FROM pages'),
    }
  })()

  async function sync(pages, read) {
    await ready
    const seen = new Set()
    let indexed = 0
    for (const page of pages) {
      if (!page || typeof page.source !== 'string' || typeof page.name !== 'string') continue
      const key = pageKey(page)
      seen.add(key)
      const existing = statements.getPage.get(key)
      if (existing && existing.size === page.size && existing.updated_at === page.updatedAt) continue
      let content
      try { content = read(page) } catch { content = null }
      if (typeof content !== 'string') continue
      // A page name like "feather-session-search-index" should match the
      // words inside it, so index it with separators turned into spaces.
      const words = page.name.replace(/[\/_-]+/g, ' ')
      db.exec('BEGIN')
      try {
        statements.deleteText.run(key)
        statements.insertText.run(words, content, key)
        statements.upsertPage.run(key, page.source, page.name, page.size, page.updatedAt)
        db.exec('COMMIT')
        indexed++
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    for (const { key } of statements.allKeys.all()) {
      if (seen.has(key)) continue
      statements.deleteText.run(key)
      statements.deletePage.run(key)
    }
    return { indexed }
  }

  function search(query, { limit = 40 } = {}) {
    if (!db) throw new Error('wiki search index is not ready')
    const expression = buildMatchExpression(query)
    if (!expression) return []
    let rows
    try { rows = statements.search.all(expression, Math.max(1, Math.min(limit, MAX_RESULTS))) } catch { return [] }
    return rows.map(row => ({ source: row.source, name: row.name, updatedAt: row.updatedAt, rank: row.rank, snippet: splitSnippet(row.snippet || '') }))
  }

  function stats() {
    if (!db) return { pages: 0, ready: false }
    return { pages: statements.countPages.get().n, ready: true }
  }

  function close() {
    if (db) { try { db.close() } catch {} }
    db = null
    statements = null
  }

  return { ready, sync, search, stats, close }
}
