import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatPair, chatFolderName, chatPairPrompts, CHAT_PAIR_EFFICIENCY_PROMPT, CHAT_PAIR_PUBLICATION_PROMPT } from '../../lib/chat-pair.js';

test('pairs agree before implementation and evaluate evidence without ceremony', () => {
  const prompts = chatPairPrompts({ groupId: 'pair', cwd: '/tmp/project', creatorSessionId: 'creator', reviewPolicy: 'always' });
  for (const prompt of Object.values(prompts)) assert.ok(prompt.includes(CHAT_PAIR_EFFICIENCY_PROMPT));
  assert.match(prompts.creator, /Both agree before building/);
  assert.match(prompts.reviewer, /against every agreed criterion/);
  assert.match(prompts.creator, /one short exchange before producing the answer/);
  assert.match(prompts.creator, /cr-agreement.creator.md/);
  assert.match(prompts.reviewer, /not independent evidence/);
  assert.match(prompts.creator, /Do not lower criteria to pass/);
  assert.match(prompts.creator, /Do not stop merely because three rounds/);
  assert.match(prompts.creator, /Review is still required/);
});

test('adaptive quick work keeps review idle while substantial work retains agreement', () => {
  const prompts = chatPairPrompts({ groupId: 'pair', cwd: '/tmp/project' });
  assert.match(prompts.creator, /without a Reviewer exchange/);
  assert.match(prompts.creator, /Keep the Reviewer idle/);
  assert.match(prompts.creator, /Both agree before building/);
  assert.match(prompts.creator, /Existing project inbox agreement and review gates always apply/);
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
  const deps = { root };
  for (const operation of ['spawn', 'prime', 'createGroup', 'teardownGroup', 'stop', 'save', 'forget']) {
    deps[operation] = async (...args) => { events.push({ operation, args }); };
  }
  return { root, events, deps: { ...deps, ...overrides } };
}

test('CR completion hands reviewed evidence to editors without waiting for optional publication', () => {
  for (const mode of [null, 'ralph']) {
    const prompts = chatPairPrompts({ groupId: 'pair', cwd: '/tmp/project', creatorSessionId: 'creator', wikiPath: '/tmp/wiki', mode });
    for (const prompt of Object.values(prompts)) {
      assert.ok(prompt.includes(CHAT_PAIR_PUBLICATION_PROMPT));
      assert.match(prompt, /supersedes earlier instructions/);
      assert.match(prompt, /reviewed inbox completion result is the durable handoff/);
      assert.match(prompt, /queued for caretaker selection and marketer editing/);
      assert.match(prompt, /Publication in Updates is optional and asynchronous/);
      assert.match(prompt, /Never gate task completion or review approval on feed appearance/);
      assert.match(prompt, /editors may combine or suppress/);
      assert.match(prompt, /updates.creator.json/);
      assert.match(prompt, /source evidence.*not direct publications/);
      assert.doesNotMatch(prompt, /Completion records appear in Updates automatically|Shared wiki edits also appear in Updates/);
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
