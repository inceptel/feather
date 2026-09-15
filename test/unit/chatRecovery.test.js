import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverChatBoundary } from '../../lib/chat-recovery.js';

const working = { mode: 'ralph', ralph: { enabled: true, status: 'working', lastBoundaryKey: 'old' } };
function completed(agent, text = 'Next iteration is useful', id = 'new') {
  if (agent === 'codex') return JSON.stringify({ type: 'event_msg', id, payload: { type: 'task_complete', last_agent_message: text } });
  if (agent === 'omp') return JSON.stringify({ type: 'message', id, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } });
  return JSON.stringify({ type: 'assistant', uuid: id, message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
}
function active(agent) {
  if (agent === 'codex') return JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', id: 'next' } });
  if (agent === 'omp') return JSON.stringify({ type: 'message', id: 'next', message: { role: 'user', content: 'Continue' } });
  return JSON.stringify({ type: 'user', uuid: 'next', message: { content: 'Continue' } });
}

for (const agent of ['claude', 'codex', 'omp']) {
  test(`${agent}: recover a boundary emitted during downtime, including natural completion and waits`, () => {
    for (const [text, field] of [['Work done\nRALPH_COMPLETE: verified outcome', 'complete'], ['Need choice\nRALPH_BLOCKED: select destination', 'blocked'], ['Review requested\nRALPH_WAITING: Reviewer verdict', 'waiting']]) {
      const result = recoverChatBoundary(working, ['partial invalid prefix', active(agent), completed(agent, text), '{malformed tail'], agent);
      assert.equal(result.key, 'new');
      assert.ok(result[field]);
    }
    assert.equal(recoverChatBoundary(working, completed(agent), agent).type, 'completed');
  });

  test(`${agent}: newer active turn and acknowledged completion never replay old work`, () => {
    assert.equal(recoverChatBoundary(working, [completed(agent), active(agent)], agent), null);
    assert.equal(recoverChatBoundary(working, [completed(agent, 'Previously seen', 'old')], agent), null);
  });
}

test('recovery never reopens stopped, blocked, complete, errored, waiting or already scheduled sessions', () => {
  for (const status of ['stopped', 'blocked', 'complete', 'error', 'waiting', 'scheduled']) {
    for (const enabled of [true, false]) assert.equal(recoverChatBoundary({ ...working, ralph: { enabled, status } }, [completed('claude')], 'claude'), null);
  }
  assert.equal(recoverChatBoundary({ ...working, mode: undefined }, [completed('claude')], 'claude'), null);
  assert.equal(recoverChatBoundary({ ...working, ralph: { enabled: false, status: 'working' } }, [completed('claude')], 'claude'), null);
});

test('missing evidence returns no boundary and does not invent activity or success', () => {
  for (const lines of [undefined, [], '', ['invalid', '{incomplete']]) assert.equal(recoverChatBoundary(working, lines, 'claude'), null);
});
