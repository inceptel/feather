import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatPair } from '../../lib/chat-pair.js';
import { resolveChatOptions, piAgentEnabled } from '../../lib/chat-config.js';
import { parseMessageForAgent } from '../../lib/parse.js';
import { messageTimestampMs } from '../../lib/sessions.js';
import { ralphBoundaryFromLine } from '../../lib/ralph.js';
import { resolveStatePaths } from '../../lib/state-paths.js';

function withFlag(t, value) {
  const previous = process.env.FEATHER_PI_AGENT;
  if (value === undefined) delete process.env.FEATHER_PI_AGENT; else process.env.FEATHER_PI_AGENT = value;
  t.after(() => { if (previous === undefined) delete process.env.FEATHER_PI_AGENT; else process.env.FEATHER_PI_AGENT = previous; });
}

function deps(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-pi-chat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  const d = { root, config: { reviewPolicy: 'none' }, ...extra };
  for (const operation of ['spawn', 'prime', 'createGroup', 'teardownGroup', 'stop', 'save', 'forget']) {
    d[operation] = async (...args) => { events.push({ operation, args }); };
  }
  return { d, events };
}

test('pi chats are refused while FEATHER_PI_AGENT is off', async t => {
  withFlag(t, undefined);
  assert.equal(piAgentEnabled(), false);
  assert.throws(() => resolveChatOptions({ agent: 'pi' }), /unsupported chat agent/);
  const { d, events } = deps(t, { piAgent: false });
  await assert.rejects(createChatPair({ agent: 'pi' }, d), { status: 400 });
  assert.equal(events.length, 0);
});

test('with the flag on, pi may start a solo chat with a per-chat model', async t => {
  withFlag(t, '1');
  const { d, events } = deps(t, { piAgent: true });
  await createChatPair({ agent: 'pi', model: 'openai-codex/gpt-5.6-sol' }, d);
  const spawn = events.find(event => event.operation === 'spawn');
  assert.equal(spawn.args[2], 'pi');
  assert.equal(spawn.args[3].model, 'openai-codex/gpt-5.6-sol');
});

test('pi is never a reviewer and never the configured default creator', async t => {
  withFlag(t, '1');
  const { d } = deps(t, { piAgent: true, config: { reviewPolicy: 'always' } });
  await assert.rejects(createChatPair({ agent: 'claude', reviewerAgent: 'pi' }, d), /unsupported chat agent/);
  assert.throws(() => resolveChatOptions({}, { creator: { agent: 'pi', model: '' } }), /unsupported chat agent/);
});

test('pi transcript lines parse as OMP messages', () => {
  const line = JSON.stringify({ type: 'message', id: 'e1', timestamp: '2026-10-04T12:00:00.000Z', modelRef: 'openai-codex/gpt-5.6-sol', upstreamProvider: 'openai-codex',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Linux' }], provider: 'gateway', model: 'openai-codex/gpt-5.6-sol', stopReason: 'stop', timestamp: 1 } });
  const parsed = parseMessageForAgent(line, 'pi');
  assert.ok(parsed);
  assert.equal(parsed.role, 'assistant');
  assert.equal(messageTimestampMs(JSON.parse(line), 'pi'), Date.parse('2026-10-04T12:00:00.000Z'));
  assert.equal(ralphBoundaryFromLine(line, 'pi').type, 'completed');
});

test('pi sessions live under the Feather home', () => {
  const paths = resolveStatePaths({ releaseDir: '/tmp/release', homeDir: '/tmp/home' });
  assert.match(paths.harness.piSessionsDir, /\/pi-sessions$/);
});
