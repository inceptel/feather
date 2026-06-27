import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

// lib/sidecar.js resolves its state dir from HOME at import time, so point HOME
// at a throwaway dir before importing it — keeps the test off the real store.
let sidecar
let tmpHome

before(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'))
  process.env.HOME = tmpHome
  sidecar = await import('../../lib/sidecar.js')
})

after(() => { try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {} })

describe('sidecar store (U2)', () => {
  it('creates a group with members and persists it', () => {
    const g = sidecar.createGroup({
      id: 'g1',
      members: [
        { sessionId: 'aaaaaaaa-1111', role: 'driver', spawned: false },
        { sessionId: 'bbbbbbbb-2222', role: 'peer', spawned: true },
      ],
      agent: 'claude', task: 'hi',
    })
    assert.equal(g.status, 'active')
    assert.equal(sidecar.getGroup('g1').members.length, 2)
    assert.ok(sidecar.listGroups().some(x => x.id === 'g1'))
  })

  it('resolves recipient by role', () => {
    const g = sidecar.getGroup('g1')
    assert.equal(sidecar.resolveRecipient(g, 'peer'), 'bbbbbbbb-2222')
    assert.equal(sidecar.resolveRecipient(g, 'driver'), 'aaaaaaaa-1111')
    assert.equal(sidecar.resolveRecipient(g, 'nobody'), null)
  })

  it('finds group + role by 8-char tmux prefix', () => {
    const g = sidecar.groupForSessionPrefix('aaaaaaaa')
    assert.equal(g?.id, 'g1')
    assert.equal(sidecar.roleForPrefix(g, 'aaaaaaaa'), 'driver')
    assert.equal(sidecar.groupForSessionPrefix('zzzzzzzz'), null)
  })

  it('appends and reads the thread in order, with timestamps', () => {
    sidecar.appendMessage('g1', { from: 'driver', to: 'peer', text: 'one' })
    sidecar.appendMessage('g1', { from: 'peer', to: 'driver', text: 'two' })
    const t = sidecar.readThread('g1')
    assert.equal(t.length, 2)
    assert.equal(t[0].text, 'one')
    assert.equal(t[1].text, 'two')
    assert.equal(t[0].from, 'driver')
    assert.ok(t[0].ts > 0)
  })

  it('teardown marks the group done; active-only prefix lookup skips it', () => {
    sidecar.teardownGroup('g1')
    assert.equal(sidecar.getGroup('g1').status, 'done')
    assert.equal(sidecar.groupForSessionPrefix('aaaaaaaa'), null)
  })

  it('priming and formatInbound include roles and task', () => {
    const p = sidecar.priming({ selfRole: 'peer', otherRole: 'driver', task: 'do X' })
    assert.match(p, /sidecar post --to driver/)
    assert.match(p, /do X/)
    assert.match(sidecar.formatInbound('peer', 'hello'), /\[sidecar message from peer\]/)
  })
})
