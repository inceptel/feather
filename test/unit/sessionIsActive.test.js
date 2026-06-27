import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sessionIsActive, ACTIVE_MS } from '../../lib/sessions.js'

// Regression: finished sessions kept showing the green "active" dot because
// isActive was true whenever a feather-* tmux session existed, which lingers up
// to the idle-reaper window (~1h). The fix requires a recent JSONL write too.
describe('sessionIsActive', () => {
  const id = 'abcdef12-3456-7890-abcd-ef1234567890'
  const prefix = id.slice(0, 8) // 'abcdef12'
  const now = 1_000_000_000_000

  it('is active when tmux is alive and the JSONL was written recently', () => {
    const active = new Set([prefix])
    assert.equal(sessionIsActive(active, id, now - 60_000, now), true)
  })

  it('is NOT active when tmux is alive but the last write is older than ACTIVE_MS', () => {
    // This is the exact bug: a lingering tmux pane with no recent activity.
    const active = new Set([prefix])
    assert.equal(sessionIsActive(active, id, now - (ACTIVE_MS + 1), now), false)
  })

  it('is NOT active when there is a recent write but no live tmux session', () => {
    const active = new Set()
    assert.equal(sessionIsActive(active, id, now - 1_000, now), false)
  })

  it('treats the ACTIVE_MS boundary as exclusive', () => {
    const active = new Set([prefix])
    assert.equal(sessionIsActive(active, id, now - ACTIVE_MS, now), false)
    assert.equal(sessionIsActive(active, id, now - (ACTIVE_MS - 1), now), true)
  })
})
