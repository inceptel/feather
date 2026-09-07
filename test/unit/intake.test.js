import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { INTAKE_ROOM, pickIntakeSession } from '../../lib/intake.js'

describe('intake chat picker', () => {
  it('names the intake Room', () => {
    assert.equal(INTAKE_ROOM, 'intake')
  })

  it('returns null when the Room has no chats', () => {
    assert.equal(pickIntakeSession([]), null)
    assert.equal(pickIntakeSession(undefined), null)
  })

  it('prefers a live chat over a newer idle one', () => {
    const picked = pickIntakeSession([
      { id: 'idle-new', updatedAt: '2026-09-07T22:00:00Z', isActive: false },
      { id: 'live-old', updatedAt: '2026-09-07T20:00:00Z', isActive: true },
    ])
    assert.equal(picked.id, 'live-old')
  })

  it('skips status reporters, wake chats, and the pulse session', () => {
    const picked = pickIntakeSession([
      { id: 'pulse', updatedAt: '2026-09-07T23:00:00Z', isActive: true, title: 'Intake status' },
      { id: 'status', updatedAt: '2026-09-07T22:30:00Z', isActive: true, title: 'Status: #intake' },
      { id: 'wake', updatedAt: '2026-09-07T22:20:00Z', isActive: false, title: 'Keep working: #intake' },
      { id: 'human', updatedAt: '2026-09-07T20:00:00Z', isActive: false, title: 'Add a room for taxes' },
    ], { skipIds: ['pulse', null] })
    assert.equal(picked.id, 'human')
    assert.equal(pickIntakeSession([{ id: 'status', title: 'Status: #intake', updatedAt: '2026-09-07T22:30:00Z' }]), null)
  })

  it('falls back to the newest chat when none is live', () => {
    const picked = pickIntakeSession([
      { id: 'older', updatedAt: '2026-09-07T20:00:00Z', isActive: false },
      { id: 'newer', updatedAt: '2026-09-07T22:00:00Z', isActive: false },
    ])
    assert.equal(picked.id, 'newer')
  })
})
