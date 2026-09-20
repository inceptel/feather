import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMessageDeliveryGate, reconcileOptimisticUserMessage } from '../../frontend/src/lib/messageDelivery.ts'

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

  it('reconciles a pasted-content transcript with its optimistic message', () => {
    const optimistic = {
      uuid: 'optimistic-1',
      role: 'user',
      timestamp: '2026-09-20T16:35:39.000Z',
      content: [{ type: 'text', text: 'where are you putting the data' }],
      delivery: 'sent',
    }
    const transcript = {
      uuid: 'transcript-1',
      role: 'user',
      timestamp: '2026-09-20T16:35:39.389Z',
      content: [{ type: 'text', text: '<pasted_content id="9583">\nwhere are you putting the data\n</pasted_content id="9583">' }],
    }

    const reconciled = reconcileOptimisticUserMessage([optimistic], transcript)
    assert.equal(reconciled.length, 1)
    assert.equal(reconciled[0].uuid, 'transcript-1')
    assert.equal(reconciled[0].delivery, 'delivered')
  })

  it('reconciles the nearest of repeated optimistic messages', () => {
    const earlier = {
      uuid: 'optimistic-earlier',
      timestamp: '2026-09-20T16:35:20.000Z',
      content: [{ type: 'text', text: 'repeat' }],
    }
    const latest = {
      uuid: 'optimistic-latest',
      timestamp: '2026-09-20T16:35:39.000Z',
      content: [{ type: 'text', text: 'repeat' }],
    }
    const transcript = {
      uuid: 'transcript-latest',
      timestamp: '2026-09-20T16:35:39.389Z',
      content: [{ type: 'text', text: '<pasted_content id="2">\nrepeat\n</pasted_content id="2">' }],
    }

    const reconciled = reconcileOptimisticUserMessage([earlier, latest], transcript)
    assert.deepEqual(reconciled.map(message => message.uuid), ['optimistic-earlier', 'transcript-latest'])
  })
})
