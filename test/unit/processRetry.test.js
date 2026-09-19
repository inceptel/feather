import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isSpawnCapacityError, retrySpawnCapacitySync } from '../../lib/process-retry.js'

describe('retrySpawnCapacitySync', () => {
  it('backs off and retries transient spawn capacity failures', () => {
    const sleeps = []
    let attempts = 0
    const result = retrySpawnCapacitySync(() => {
      attempts++
      if (attempts < 3) throw Object.assign(new Error('spawn tmux EAGAIN'), { code: 'EAGAIN' })
      return 'ok'
    }, { delaysMs: [25, 100, 250], sleep: ms => sleeps.push(ms) })

    assert.equal(result, 'ok')
    assert.equal(attempts, 3)
    assert.deepEqual(sleeps, [25, 100])
  })

  it('does not retry command failures or hide exhausted capacity errors', () => {
    let permanentAttempts = 0
    assert.throws(() => retrySpawnCapacitySync(() => {
      permanentAttempts++
      throw Object.assign(new Error('tmux target missing'), { status: 1 })
    }, { sleep: () => {} }), /target missing/)
    assert.equal(permanentAttempts, 1)

    let capacityAttempts = 0
    assert.throws(() => retrySpawnCapacitySync(() => {
      capacityAttempts++
      throw Object.assign(new Error('spawn tmux EAGAIN'), { errno: -11, syscall: 'spawn tmux' })
    }, { delaysMs: [1, 2], sleep: () => {} }), /EAGAIN/)
    assert.equal(capacityAttempts, 3)
  })
})

describe('isSpawnCapacityError', () => {
  it('recognizes only process spawn capacity failures', () => {
    assert.equal(isSpawnCapacityError({ code: 'EAGAIN' }), true)
    assert.equal(isSpawnCapacityError({ errno: -11, syscall: 'spawn tmux' }), true)
    assert.equal(isSpawnCapacityError({ errno: -11, syscall: 'read' }), false)
    assert.equal(isSpawnCapacityError({ code: 'ENOENT' }), false)
  })
})
