import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { agentNotice } from '../../frontend/src/lib/agentNotice.ts'

describe('agentNotice', () => {
  it('labels Feather and tool messages with an emoji', () => {
    assert.deepEqual(agentNotice('<feather-ralph-callback event="turn_complete" iteration="12">\nContinue.\n</feather-ralph-callback>')?.label, 'Ralph · iteration 12')
    assert.equal(agentNotice('<feather-ralph-callback event="x">go</feather-ralph-callback>')?.label, 'Ralph')
    assert.equal(agentNotice('The user clicked Keep working. Continue the selected idea.')?.icon, '🖍️')
    assert.equal(agentNotice('This session is being continued from a previous conversation that ran out of context.')?.label, 'Compacted')
    assert.equal(agentNotice('[feather-sidecar pair from reviewer] hi')?.label, 'Sidecar message')
    assert.equal(agentNotice('You are part of a Creator–Reviewer (CR) pair in Feather. More.')?.label, 'Agent setup')
  })
  it('unwraps pasted Inbox replies and names the thread', () => {
    const n = agentNotice('\n\n<pasted_content id="20e0">\nPlannotator Inbox reply on "Test: reply here" (reply msg_1, thread msg_0).\n\nAnswer: Yes\n</pasted_content id="20e0">')
    assert.equal(n?.icon, '📬')
    assert.equal(n?.label, 'Inbox reply · Test: reply here')
    assert.ok(n?.body.startsWith('Plannotator Inbox reply on') && n.body.endsWith('Answer: Yes'))
  })
  it('leaves the person\'s own messages alone', () => {
    for (const t of ['Please check my report.', 'what does <feather-ralph-callback> mean?', 'Plannotator Inbox is cool']) assert.equal(agentNotice(t), null)
  })
})
