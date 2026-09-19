import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMessageDeliveryGate } from '../../frontend/src/lib/messageDelivery.ts'

describe('createMessageDeliveryGate', () => {
  it('coalesces concurrent sends for one chat into one delivery', async () => {
    const gate = createMessageDeliveryGate(() => 'message-1')
    let deliveries = 0
    let release
    const deliver = async id => {
      deliveries++
      assert.equal(id, 'message-1')
      return new Promise(resolve => { release = resolve })
    }

    const first = gate.run('local-chat', 'hello', deliver)
    const duplicate = gate.run('local-chat', 'hello', deliver)
    await Promise.resolve()
    assert.equal(first, duplicate)
    assert.equal(deliveries, 1)
    release('sent')
    assert.equal(await duplicate, 'sent')
  })

  it('reuses a failed delivery id for retry but not a later intentional repeat', async () => {
    const ids = ['message-1', 'message-2', 'message-3']
    const gate = createMessageDeliveryGate(() => ids.shift())
    const seen = []

    await assert.rejects(gate.run('local-chat', 'hello', async id => { seen.push(id); throw new Error('lost acknowledgement') }))
    assert.equal(await gate.run('local-chat', 'hello', async id => { seen.push(id); return 'retried' }), 'retried')
    assert.equal(await gate.run('local-chat', 'hello', async id => { seen.push(id); return 'intentional repeat' }), 'intentional repeat')
    assert.deepEqual(seen, ['message-1', 'message-1', 'message-2'])
  })

  it('preserves a durable attachment id across a failed retry', async () => {
    const gate = createMessageDeliveryGate(() => 'generated')
    await assert.rejects(gate.run('local-chat', 'attachment', async id => { assert.equal(id, 'upload-123'); throw new Error('offline') }, 'upload-123'))
    const retried = await gate.run('local-chat', 'attachment', async id => id, 'different-upload')
    assert.equal(retried, 'upload-123')
  })
})
