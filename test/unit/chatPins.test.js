import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatPins } from '../../lib/chat-pins.js'

test('legacy entrances become pins without writing; unpin/archive survive restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-pins-'))
  try {
    const file = path.join(root, 'pins.json')
    const rooms = [{ name: 'boat', leaderSessionId: 'boat-chat', sessions: [{ id: 'boat-chat' }] }]
    const store = createChatPins({ file, root })
    assert.deepEqual(store.snapshot(rooms).pins, [{ id: 'boat-chat', title: 'boat', legacy: true }])
    assert.equal(fs.existsSync(file), false)
    store.set('boat-chat', { pinned: false })
    assert.deepEqual(createChatPins({ file, root }).snapshot(rooms).pins, [])
    store.set('fresh-chat', { pinned: true, title: 'Strategy A' })
    store.set('fresh-chat', { archived: true })
    assert.deepEqual(store.snapshot(rooms).archived, ['fresh-chat'])
    assert.deepEqual(store.snapshot(rooms).pins, [])
    store.set('fresh-chat', { archived: false })
    assert.deepEqual(store.snapshot(rooms).pins, [{ id: 'fresh-chat', title: 'Strategy A' }])
    assert.throws(() => store.set('../escape', { pinned: true }))
    assert.throws(() => store.set('fresh-chat', { pinned: 'yes' }))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
