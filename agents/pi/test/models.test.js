import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchModelRef, createAgentModels, defaultModelRef, FALLBACK_DEFAULT_MODEL, parseModelRef, readKeyvaultKey, upstreamOf } from '../src/models.js';

test('default model is Codex unless configured', () => {
  assert.equal(defaultModelRef({}), FALLBACK_DEFAULT_MODEL);
  assert.match(FALLBACK_DEFAULT_MODEL, /^openai-codex\//);
  assert.equal(defaultModelRef({ FEATHER_PI_DEFAULT_MODEL: 'anthropic/claude-opus-5-5' }), 'anthropic/claude-opus-5-5');
  assert.equal(defaultModelRef({ FEATHER_PI_DEFAULT_MODEL: 'bad ref; rm' }), FALLBACK_DEFAULT_MODEL);
});

test('model refs route to gateway or OpenRouter', () => {
  assert.deepEqual(parseModelRef('openai-codex/gpt-5.6-sol'), { provider: 'gateway', modelId: 'openai-codex/gpt-5.6-sol', upstream: 'openai-codex', ref: 'openai-codex/gpt-5.6-sol' });
  assert.equal(parseModelRef('openrouter/moonshotai/kimi-k2').provider, 'openrouter');
  assert.equal(parseModelRef('openrouter/moonshotai/kimi-k2').modelId, 'moonshotai/kimi-k2');
  assert.equal(parseModelRef('nope'), null);
  assert.equal(upstreamOf('gateway', 'anthropic/claude-opus-5-5'), 'anthropic');
  assert.equal(upstreamOf('openrouter', 'x/y'), 'openrouter');
});

test('ensure registers gateway models on demand', () => {
  const { models, ensure } = createAgentModels({ gatewayUrl: 'http://127.0.0.1:1', tokenFile: '/nonexistent' });
  assert.deepEqual(ensure('openai-codex/gpt-5.6-sol'), { provider: 'gateway', modelId: 'openai-codex/gpt-5.6-sol' });
  const model = models.getModel('gateway', 'openai-codex/gpt-5.6-sol');
  assert.equal(model.baseUrl, 'http://127.0.0.1:1');
  assert.equal(model.api, 'anthropic-messages');
  assert.throws(() => ensure('bad'), /invalid model/);
});

test('keyvault reader returns one key only', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-kv-')), 'kv');
  fs.writeFileSync(file, 'OTHER=1\nexport OPENROUTER_API_KEY="sk-test"\n');
  assert.equal(readKeyvaultKey(file, 'OPENROUTER_API_KEY'), 'sk-test');
  assert.equal(readKeyvaultKey(file, 'MISSING'), undefined);
  assert.equal(readKeyvaultKey('/nonexistent', 'X'), undefined);
});

test('model names typed loosely resolve; typos get suggestions', () => {
  const available = ['anthropic/claude-opus-5', 'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5', 'openai-codex/gpt-5.6-sol'];
  assert.deepEqual(matchModelRef('anthropic/claude-opus-5-5', available), { ref: 'anthropic/claude-opus-5-5' });
  assert.deepEqual(matchModelRef('anthropic/claude-opus5.5', available), { ref: 'anthropic/claude-opus-5-5' });
  assert.deepEqual(matchModelRef('Anthropic/Claude-Opus-5.5', available), { ref: 'anthropic/claude-opus-5-5' });
  const typo = matchModelRef('anthropix/claude-opus-5.5', available);
  assert.equal(typo.ref, undefined);
  assert.equal(typo.suggestions[0], 'anthropic/claude-opus-5-5');
});
