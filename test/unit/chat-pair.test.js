import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatPair, chatFolderName } from '../../lib/chat-pair.js';

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
