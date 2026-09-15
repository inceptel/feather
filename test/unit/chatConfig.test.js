import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadChatConfig, resolveChatOptions, validateChatConfig } from '../../lib/chat-config.js';

test('missing machine settings resolve safe defaults without writing a file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const config = loadChatConfig({ file, env: {} });
  assert.equal(config.creator.agent, 'claude');
  assert.equal(config.reviewer.agent, 'codex');
  assert.equal(config.reviewPolicy, 'adaptive');
  assert.equal(config.standbyPairs, 1);
  assert.equal(fs.existsSync(file), false);
  assert.equal(loadChatConfig({ file, env: { FEATHER_CHAT_POOL_SIZE: '0' } }).standbyPairs, 0);
});

test('local policy loads models and explicit engine overrides do not inherit another engine model', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ creator: { agent: 'omp', model: 'provider/model' }, reviewer: { agent: 'claude', model: 'review-model' }, reviewPolicy: 'always' }));
  const config = loadChatConfig({ env: { FEATHER_CHAT_CONFIG: file } });
  assert.equal(resolveChatOptions({}, config).model, 'provider/model');
  assert.equal(resolveChatOptions({ agent: 'codex' }, config).model, '');
  assert.equal(resolveChatOptions({ reviewerAgent: 'omp', reviewerModel: 'custom' }, config).reviewerModel, 'custom');
  assert.equal(resolveChatOptions({}, config).reviewPolicy, 'always');
});

test('invalid policy and command-like models fail closed', () => {
  for (const value of [null, [], { creator: 'codex' }, { creator: { agent: 'shell' } },
    { reviewer: { model: '$(unsafe)' } }, { standbyPairs: 100 }, { standbyPairs: 1.5 },
    { reviewPolicy: 'never' }, { progressIntervalMinutes: 0 }]) {
    assert.throws(() => validateChatConfig(value));
  }
  assert.throws(() => resolveChatOptions({ model: '--bad model' }));
});
