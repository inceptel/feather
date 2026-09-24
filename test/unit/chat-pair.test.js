import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatPair, chatFolderName, chatPairPrompts, CHAT_PAIR_EFFICIENCY_PROMPT, CHAT_PAIR_PUBLICATION_PROMPT } from '../../lib/chat-pair.js';

test('always-review pairs get the efficiency block and a recoverable agreement file', () => {
  const prompts = chatPairPrompts({ groupId: 'pair', cwd: '/tmp/project', creatorSessionId: 'creator', reviewPolicy: 'always' });
  for (const prompt of Object.values(prompts)) assert.ok(prompt.includes(CHAT_PAIR_EFFICIENCY_PROMPT));
  assert.match(prompts.creator, /cr-agreement.creator.md/);
});

test('adaptive pairs omit the always-review efficiency block', () => {
  const prompts = chatPairPrompts({ groupId: 'pair', cwd: '/tmp/project' });
  assert.ok(!prompts.creator.includes(CHAT_PAIR_EFFICIENCY_PROMPT));
});

test('pair saves resolved models and policy before exposing allocation', async t => {
  const { events, deps } = fixture(t);
  deps.onAllocated = entry => { events.push({ operation: 'allocated', args: [entry] }); };
  await createChatPair({ agent: 'omp', model: 'provider/model', reviewerAgent: 'claude', reviewerModel: 'other-model', reviewPolicy: 'always' }, deps);
  const saved = events.find(event => event.operation === 'save').args[0];
  assert.equal(saved.model, 'provider/model');
  assert.equal(saved.reviewerModel, 'other-model');
  assert.equal(saved.reviewPolicy, 'always');
  assert.ok(events.findIndex(event => event.operation === 'allocated') > events.findIndex(event => event.operation === 'save'));
  assert.ok(events.findIndex(event => event.operation === 'allocated') < events.findIndex(event => event.operation === 'spawn'));
  const launches = events.filter(event => event.operation === 'spawn');
  assert.equal(launches[0].args[3].ompModel, 'provider/model');
  assert.equal(launches[1].args[3].model, 'other-model');
});

test('standby rejects task content and failure can retain hidden identity', async t => {
  const { deps, events } = fixture(t);
  await assert.rejects(createChatPair({ standby: true, prompt: 'Do work' }, deps), { status: 400 });
  deps.prime = async () => { throw new Error('startup failure'); };
  deps.retire = entry => { events.push({ operation: 'retire', args: [entry] }); };
  await assert.rejects(createChatPair({ standby: true }, deps), /startup failure/);
  assert.equal(events.filter(event => event.operation === 'retire').length, 1);
  assert.equal(events.filter(event => event.operation === 'forget').length, 0);
});

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-chat-pair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  // Pair fixtures opt into a Reviewer; the machine default is now a solo chat.
  const deps = { root, config: { reviewPolicy: 'adaptive' } };
  for (const operation of ['spawn', 'prime', 'createGroup', 'teardownGroup', 'stop', 'save', 'forget']) {
    deps[operation] = async (...args) => { events.push({ operation, args }); };
  }
  return { root, events, deps: { ...deps, ...overrides } };
}

test('every pair prompt carries the publication handoff and its per-creator updates file', () => {
  for (const mode of [null, 'ralph']) {
    const prompts = chatPairPrompts({ groupId: 'pair', cwd: '/tmp/project', creatorSessionId: 'creator', wikiPath: '/tmp/wiki', mode });
    for (const prompt of Object.values(prompts)) {
      assert.ok(prompt.includes(CHAT_PAIR_PUBLICATION_PROMPT));
      assert.match(prompt, /updates.creator.json/);
    }
  }
});

test('new chats have isolated readable folders and correctly addressed CR prompts', async t => {
  const { root, events, deps } = fixture(t);
  const first = await createChatPair({ name: 'Boat Battery', prompt: 'Compare two batteries' }, deps);
  const second = await createChatPair({ name: 'Boat Battery' }, deps);
  assert.equal(first.cwd, path.join(root, 'boat-battery'));
  assert.equal(second.cwd, path.join(root, 'boat-battery-2'));
  const group = events.find(e => e.operation === 'createGroup').args[0];
  assert.equal(group.durable, true);
  assert.deepEqual(group.members, [
    { sessionId: first.id, role: 'creator', spawned: false },
    { sessionId: first.reviewerSessionId, role: 'reviewer', spawned: true },
  ]);
  const primes = events.filter(e => e.operation === 'prime').slice(0, 2);
  assert.equal(primes[0].args[0], first.reviewerSessionId);
  assert.equal(primes[1].args[0], first.id);
  for (const { args: [, prompt] } of primes) {
    assert.ok(prompt.includes(`--group ${first.groupId}`));
    assert.ok(prompt.includes('Compare two batteries'));
    assert.ok(prompt.includes('Do not poll'));
  }
  assert.match(primes[1].args[1], /exact user objective/);
  assert.match(primes[0].args[1], /Do not edit/);
});

test('failed spawn stops both fresh sessions and removes registration and empty folder', async t => {
  const { root, events, deps } = fixture(t);
  let count = 0;
  deps.spawn = async () => { if (++count === 2) throw new Error('harness failure'); };
  await assert.rejects(createChatPair({ name: 'Test' }, deps), /harness failure/);
  assert.equal(events.filter(e => e.operation === 'stop').length, 2);
  assert.equal(events.filter(e => e.operation === 'teardownGroup').length, 1);
  assert.equal(events.filter(e => e.operation === 'forget').length, 1);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('two CR pairs share an existing project without sharing identity or update files', async t => {
  const { events, deps } = fixture(t);
  const first = await createChatPair({ name: 'Strategy A' }, deps);
  deps.resolveProject = id => { assert.equal(id, first.id); return { cwd: first.cwd, projectId: first.projectId }; };
  const second = await createChatPair({ name: 'Strategy B', projectSessionId: first.id }, deps);
  assert.equal(second.cwd, first.cwd);
  assert.equal(second.projectId, first.projectId);
  assert.notEqual(second.groupId, first.groupId);
  const prompts = events.filter(e => e.operation === 'save').map(e => e.args[0].rolePrompts.creator);
  assert.ok(prompts[0].includes(`updates.${first.id}.json`));
  assert.ok(prompts[1].includes(`updates.${second.id}.json`));
  deps.spawn = async () => { throw new Error('no harness'); };
  await assert.rejects(createChatPair({ projectSessionId: first.id }, deps), /no harness/);
  assert.ok(fs.statSync(first.cwd).isDirectory(), 'failed pair never removes an existing project');
});

test('Ralph belongs to the creator while durable role prompts survive without replaying the first task', async t => {
  const { events, deps } = fixture(t, { wikiPath: '/shared/wiki' });
  const result = await createChatPair({ name: 'Trading', mode: 'ralph', prompt: 'Analyze strategy A' }, deps);
  assert.equal(result.mode, 'ralph');
  const launches = events.filter(e => e.operation === 'spawn');
  assert.deepEqual(launches[0].args, [result.id, result.cwd, 'claude', { mode: 'ralph' }]);
  assert.deepEqual(launches[1].args, [result.reviewerSessionId, result.cwd, 'codex']);
  const saved = events.find(e => e.operation === 'save').args[0];
  assert.match(saved.rolePrompts.creator, /Only declare completion after the Reviewer accepts/);
  assert.match(saved.rolePrompts.reviewer, /never run an independent Ralph loop/);
  assert.match(saved.rolePrompts.creator, /RALPH_WAITING: Awaiting Reviewer verdict/);
  assert.match(saved.rolePrompts.creator, /Shared Feather wiki: "\/shared\/wiki"/);
  assert.match(saved.rolePrompts.reviewer, /exact Reviewer-approved wiki changes/);
  assert.ok(!saved.rolePrompts.creator.includes('Analyze strategy A'));
  assert.ok(!saved.rolePrompts.reviewer.includes('Analyze strategy A'));
  assert.ok(events.findIndex(e => e.operation === 'save') < events.findIndex(e => e.operation === 'spawn'));
  assert.ok(events.filter(e => e.operation === 'prime').every(e => e.args[1].includes('Analyze strategy A')));
});

test('failed priming preserves generated files while stopping agents', async t => {
  const { root, events, deps } = fixture(t);
  deps.prime = async () => {
    fs.writeFileSync(path.join(root, 'test', 'work.txt'), 'keep');
    throw new Error('send failure');
  };
  await assert.rejects(createChatPair({ name: 'Test' }, deps), /send failure/);
  assert.equal(fs.readFileSync(path.join(root, 'test', 'work.txt'), 'utf8'), 'keep');
  assert.equal(events.filter(e => e.operation === 'stop').length, 2);
});

test('invalid agent and oversized input fail before creating files or sessions', async t => {
  const { root, events, deps } = fixture(t);
  for (const body of [{ agent: 'shell' }, { reviewerAgent: 'bad' }, { name: {} }, { prompt: 'x'.repeat(16001) }, { mode: 'bad' }]) {
    await assert.rejects(createChatPair(body, deps), { status: 400 });
  }
  assert.deepEqual(events, []);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(chatFolderName('../../ Boat; $(touch bad)'), 'boat-touch-bad');
});

test('the default chat is solo: one agent, no group, no reviewer, and a prompt that says so', async t => {
  const { events, deps } = fixture(t, { config: {} });
  const chat = await createChatPair({ name: 'Solo Plan', prompt: 'Draft the plan' }, deps);
  assert.equal(chat.reviewerSessionId, null);
  assert.equal(chat.groupId, null);
  assert.equal(events.filter(e => e.operation === 'createGroup').length, 0);
  assert.equal(events.filter(e => e.operation === 'spawn').length, 1);
  const primes = events.filter(e => e.operation === 'prime');
  assert.equal(primes.length, 1);
  assert.equal(primes[0].args[0], chat.id);
  assert.match(primes[0].args[1], /Draft the plan/);
  assert.match(primes[0].args[1], /sole agent/);
  assert.match(primes[0].args[1], /no Reviewer and no sidecar group/);
  assert.doesNotMatch(primes[0].args[1], /sidecar post|Creator–Reviewer \(CR\) pair/);
  const saved = events.find(e => e.operation === 'save').args[0];
  assert.equal(saved.reviewPolicy, 'none');
  assert.equal(saved.reviewerSessionId ?? null, null);
  const paired = await createChatPair({ name: 'Paired', reviewPolicy: 'adaptive' }, deps);
  assert.ok(paired.reviewerSessionId && paired.groupId, 'an explicit policy still creates a pair');
});
