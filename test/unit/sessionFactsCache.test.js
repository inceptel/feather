import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { createSessionFactsCache } from '../../lib/session-facts-cache.js'

const roots = []
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-session-facts-'))
  roots.push(root)
  return path.join(root, 'cache', 'session-facts.json')
}

function facts(overrides = {}) {
  return {
    mtimeMs: 100,
    size: 200,
    agent: 'claude',
    projectId: '-home-user-project',
    title: 'A durable title',
    worker: false,
    activityMs: 90,
    ...overrides,
  }
}

describe('session facts cache', () => {
  it('restores transcript facts after a process-style reload', async () => {
    const file = fixture()
    const first = createSessionFactsCache({ file, writeDelayMs: 60_000 })
    first.set('/sessions/a.jsonl', facts())
    await first.flush()

    const restored = createSessionFactsCache({ file, writeDelayMs: 60_000 })
    assert.deepEqual(restored.get('/sessions/a.jsonl'), facts())
  })

  it('forgets facts whose transcript no longer exists', async () => {
    const file = fixture()
    const cache = createSessionFactsCache({ file, writeDelayMs: 60_000 })
    cache.set('/sessions/a.jsonl', facts())
    cache.set('/sessions/b.jsonl', facts({ title: 'B' }))
    cache.retain(new Set(['/sessions/b.jsonl']))
    await cache.flush()

    const restored = createSessionFactsCache({ file, writeDelayMs: 60_000 })
    assert.equal(restored.get('/sessions/a.jsonl'), undefined)
    assert.equal(restored.get('/sessions/b.jsonl').title, 'B')
  })
})
