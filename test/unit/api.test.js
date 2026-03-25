import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// API tests run against a live server.
// Start it first: PORT=14870 node server.js
// Or test against the default running instance on 4870.
const PORT = process.env.TEST_PORT || 4870
const BASE = `http://localhost:${PORT}`

before(async () => {
  // Verify server is reachable
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Server not reachable at ${BASE}. Start it first: node server.js`)
})

describe('GET /api/health', () => {
  it('returns ok status', async () => {
    const r = await fetch(`${BASE}/api/health`)
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(body.status, 'ok')
    assert.ok(typeof body.uptime === 'number')
  })
})

describe('GET /api/sessions', () => {
  it('returns sessions array', async () => {
    const r = await fetch(`${BASE}/api/sessions`)
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.ok(Array.isArray(body.sessions))
  })

  it('respects limit parameter', async () => {
    const r = await fetch(`${BASE}/api/sessions?limit=5`)
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.ok(body.sessions.length <= 5)
  })

  it('sessions have expected shape', async () => {
    const r = await fetch(`${BASE}/api/sessions`)
    const body = await r.json()
    for (const s of body.sessions.slice(0, 3)) {
      assert.ok(s.id, 'session missing id')
      assert.ok(s.title, 'session missing title')
      assert.ok(s.updatedAt, 'session missing updatedAt')
      assert.equal(typeof s.isActive, 'boolean', 'isActive should be boolean')
    }
  })
})

describe('GET /api/sessions/:id/messages', () => {
  it('returns empty array for nonexistent session', async () => {
    const r = await fetch(`${BASE}/api/sessions/nonexistent-fake-id/messages`)
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.deepEqual(body.messages, [])
  })

  it('returns messages with expected shape for real session', async () => {
    const sr = await fetch(`${BASE}/api/sessions?limit=1`)
    const { sessions } = await sr.json()
    if (sessions.length === 0) return

    const r = await fetch(`${BASE}/api/sessions/${sessions[0].id}/messages`)
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.ok(Array.isArray(body.messages))
    for (const msg of body.messages.slice(0, 3)) {
      assert.ok(msg.uuid, 'message missing uuid')
      assert.ok(msg.role, 'message missing role')
      assert.ok(msg.timestamp, 'message missing timestamp')
      assert.ok(Array.isArray(msg.content), 'content should be array')
    }
  })
})

describe('GET /api/sessions/:id/stream (SSE)', () => {
  it('connects and receives connected event', async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const r = await fetch(`${BASE}/api/sessions/test-sse-fake/stream`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      })
      assert.equal(r.status, 200)
      assert.ok(r.headers.get('content-type').includes('text/event-stream'))

      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      const { value } = await reader.read()
      const text = decoder.decode(value)
      assert.ok(text.includes('event: connected'), `expected connected event, got: ${text}`)
      controller.abort()
    } finally {
      clearTimeout(timeout)
    }
  })
})

describe('POST /api/sessions/:id/interrupt', () => {
  it('returns error for nonexistent session', async () => {
    const r = await fetch(`${BASE}/api/sessions/nonexistent-id/interrupt`, {
      method: 'POST',
    })
    assert.equal(r.status, 500)
  })
})

describe('static file serving', () => {
  it('serves index.html at root', async () => {
    const staticDir = path.join(__dirname, '..', '..', 'static')
    if (!fs.existsSync(path.join(staticDir, 'index.html'))) return

    const r = await fetch(`${BASE}/`)
    assert.equal(r.status, 200)
    const html = await r.text()
    assert.ok(html.includes('</html>'))
  })
})
