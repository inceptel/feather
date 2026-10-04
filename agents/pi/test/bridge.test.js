import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeClient, createEventMapper, sessionStateEvent } from '../src/bridge.js';

function mapper() {
  const out = [];
  const timers = [];
  const m = createEventMapper({ emit: events => out.push(...events), setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  return { m, out, tick: () => timers.splice(0).forEach(fn => fn()) };
}

test('streams text snapshots and ends a plain answer', () => {
  const { m, out, tick } = mapper();
  m.handleBatch([{ type: 'run_start' }, { type: 'message_start', message: { role: 'assistant', content: [] } }]);
  m.handle({ type: 'message_update', changes: [{ type: 'text_start', contentIndex: 0, block: { type: 'text', text: '' } }, { type: 'text_delta', contentIndex: 0, delta: 'Hel' }] });
  tick();
  m.handle({ type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 0, delta: 'lo' }] });
  m.handle({ type: 'message_end', entry: { model: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello' }], stopReason: 'stop' }] } });
  m.handle({ type: 'run_end' });
  const types = out.map(e => e.type);
  assert.deepEqual(types, ['agent_start', 'assistant_snapshot', 'assistant_snapshot', 'assistant_end', 'agent_end']);
  assert.equal(out[2].text, 'Hello');
  assert.equal(out[1].messageId, out[3].messageId);
});

test('tool rounds cancel the segment with willContinue and report tool output', () => {
  const { m, out } = mapper();
  m.handle({ type: 'message_start', message: { role: 'assistant', content: [] } });
  m.handle({ type: 'message_end', entry: { model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }], stopReason: 'toolUse' }] } });
  m.handle({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } });
  m.handle({ type: 'tool_execution_update', toolCallId: 't1', toolName: 'bash', output: { append: 'a' } });
  m.handle({ type: 'tool_execution_update', toolCallId: 't1', toolName: 'bash', output: { append: 'b' } });
  m.handle({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', entry: { model: [{ role: 'toolResult', content: [{ type: 'text', text: 'ab' }], isError: false }] } });
  const cancel = out.find(e => e.type === 'assistant_cancel');
  assert.equal(cancel.willContinue, true);
  assert.deepEqual(out.find(e => e.type === 'work_snapshot').blocks, [{ type: 'tool_use', id: 't1', name: 'bash' }]);
  assert.equal(out.filter(e => e.type === 'tool_execution_update').at(-1).partialResult.content[0].text, 'ab');
  const end = out.find(e => e.type === 'tool_execution_end');
  assert.equal(end.isError, false);
  assert.equal(end.result.content[0].text, 'ab');
});

test('aborted answer cancels without willContinue', () => {
  const { m, out } = mapper();
  m.handle({ type: 'message_start', message: { role: 'assistant', content: [] } });
  m.handle({ type: 'message_end', entry: { model: [{ role: 'assistant', content: [{ type: 'text', text: 'par' }], stopReason: 'aborted' }] } });
  const cancel = out.find(e => e.type === 'assistant_cancel');
  assert.equal(cancel.willContinue, undefined);
});

test('session_state names the model', () => {
  assert.deepEqual(sessionStateEvent('openai-codex/gpt-5.6-sol'), { type: 'session_state', modelProvider: 'openai-codex', modelId: 'openai-codex/gpt-5.6-sol', modelApi: 'anthropic-messages', serviceTiers: {} });
});

test('client posts version 4 batches with the bridge token header', async () => {
  const calls = [];
  const client = createBridgeClient({ url: 'http://x/events', token: 'tok', fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true }; } });
  client.post([{ type: 'agent_start' }, { type: 'agent_end' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['X-Feather-Bridge-Token'], 'tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { version: 4, events: [{ type: 'agent_start' }, { type: 'agent_end' }] });
});

test('client without a token sends nothing', async () => {
  let called = false;
  const client = createBridgeClient({ url: 'http://x', token: undefined, fetchImpl: async () => { called = true; return { ok: true }; } });
  client.post([{ type: 'agent_start' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(called, false);
});
