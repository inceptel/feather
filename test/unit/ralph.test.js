import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  publicRalphState,
  ralphBoundaryFromLine,
  ralphContinuationPrompt,
  ralphSystemPrompt,
} from '../../lib/ralph.js'

describe('Ralph contract', () => {
  it('keeps the system prompt platform-neutral and bounded by human authority', () => {
    const prompt = ralphSystemPrompt()
    assert.match(prompt, /durable owner/)
    assert.match(prompt, /Long context is never a reason to stop/)
    assert.match(prompt, /Do not invent churn/)
    assert.match(prompt, /irreducible human action/)
    assert.match(prompt, /RALPH_COMPLETE:/)
    assert.match(prompt, /RALPH_BLOCKED:/)
    assert.doesNotMatch(prompt, /\.claude|\.codex|\.omp|Telegram|\/home\//)
  })

  it('emits a trusted continuation callback with a stable iteration', () => {
    const prompt = ralphContinuationPrompt(7)
    assert.match(prompt, /<feather-ralph-callback event="turn_complete" iteration="7">/)
    assert.match(prompt, /RALPH_COMPLETE:/)
    assert.match(prompt, /next highest-leverage justified action/)
  })

  it('recognizes OMP completion and ignores tool segments', () => {
    const tool = JSON.stringify({ type: 'message', id: 'm1', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'toolCall' }] } })
    const done = JSON.stringify({ type: 'message', id: 'm2', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Shipped.' }] } })
    assert.equal(ralphBoundaryFromLine(tool, 'omp'), null)
    assert.deepEqual(ralphBoundaryFromLine(done, 'omp'), { type: 'completed', key: 'm2', blocked: null })
  })

  it('pauses a completed objective instead of manufacturing more work', () => {
    const done = JSON.stringify({ type: 'message', id: 'm-complete', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'All work verified.\nRALPH_COMPLETE: objective shipped and verified' }] } })
    assert.deepEqual(ralphBoundaryFromLine(done, 'omp'), {
      type: 'completed',
      key: 'm-complete',
      blocked: null,
      complete: 'objective shipped and verified',
    })
  })

  it('recognizes Claude completion without treating tool results as human interruption', () => {
    const toolResult = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
    const done = JSON.stringify({ type: 'assistant', uuid: 'a1', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Waiting.\nRALPH_BLOCKED: approve production publish' }] } })
    assert.equal(ralphBoundaryFromLine(toolResult, 'claude'), null)
    assert.deepEqual(ralphBoundaryFromLine(done, 'claude'), { type: 'completed', key: 'a1', blocked: 'approve production publish' })
  })

  it('recognizes Codex task completion and its turn identity', () => {
    const done = JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'task_complete', turn_id: 'turn-9', last_agent_message: 'Ready' } })
    assert.deepEqual(ralphBoundaryFromLine(done, 'codex'), { type: 'completed', key: 'turn-9', blocked: null })
  })

  it('publishes only the bounded Ralph state', () => {
    assert.equal(publicRalphState({ agent: 'omp' }), undefined)
    assert.deepEqual(publicRalphState({ mode: 'ralph', ralph: { enabled: false, status: 'blocked', iteration: 3, blockedReason: 'need key', private: 'no' } }), {
      enabled: false,
      status: 'blocked',
      iteration: 3,
      lastCallbackAt: null,
      blockedReason: 'need key',
      completionReason: null,
      error: null,
    })
  })
})
