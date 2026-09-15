import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { createProjectInbox } from '../../lib/project-inbox.js';
import { installProjectInboxRoutes, projectInboxUpdates } from '../../lib/project-inbox-api.js';

test('two authenticated pairs share durable work, reject defects and publish only approved completion', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-api-'));
  const meta = {};
  for (const pair of ['a', 'b']) for (const role of ['creator', 'reviewer']) {
    const id = `${pair}-${role}`;
    meta[id] = { title: 'Tic tac toe', chatProjectId: 'tic-tac-toe', chatRole: role,
      chatPair: { creatorSessionId: `${pair}-creator`, reviewerSessionId: `${pair}-reviewer` } };
  }
  let server, base, store;
  const changes = [];
  async function start() {
    store = createProjectInbox({ root });
    const app = express(); app.use(express.json());
    installProjectInboxRoutes(app, { store, readMeta: () => meta,
      tokenValid: (id, value) => value === `test-${id}`, changed: (...args) => changes.push(args) });
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { if (server?.listening) { server.close(); server.closeAllConnections(); await once(server, 'close'); } }
  t.after(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); });
  async function post(url, body, token, status = 200) {
    const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(token ? { 'X-Feather-Bridge-Token': token } : {}) }, body: JSON.stringify(body) });
    const result = await res.json(); assert.equal(res.status, status, JSON.stringify(result)); return result;
  }
  const agent = (id, action, body = {}, status) => post(`/api/internal/sessions/${id}/inbox`, { action, ...body }, `test-${id}`, status);
  await start();
  await post('/api/chats/a-creator/inbox/config', { objective: 'Build tic tac toe', allowIdeas: true, maxGeneratedTasks: 1 });
  for (let n = 1; n <= 6; n++) await post('/api/chats/a-creator/inbox/tasks', { id: `task-${n}`, title: `Requirement ${n}` });
  await post('/api/internal/sessions/a-creator/inbox', { action: 'claim' }, 'bad', 403);
  await agent('a-reviewer', 'claim', {}, 403);
  const [a, b] = await Promise.all([agent('a-creator', 'claim'), agent('b-creator', 'claim')]);
  assert.notEqual(a.task.id, b.task.id);
  await stop(); await start();
  assert.equal((await agent('a-creator', 'claim')).task.id, a.task.id, 'restart resumes the same claim');
  await agent('a-creator', 'propose', { taskId: a.task.id, criteria: ['All eight win lines work'] });
  await agent('a-creator', 'agree', { taskId: a.task.id }, 403);
  await agent('b-reviewer', 'agree', { taskId: a.task.id }, 403);
  await agent('a-reviewer', 'agree', { taskId: a.task.id });
  await agent('a-creator', 'submit', { taskId: a.task.id, revision: 'broken-v1' });
  await agent('a-reviewer', 'review', { taskId: a.task.id, revision: 'broken-v1', verdict: 'REVISE', evidence: 'Anti-diagonal win fails: [2,4,6]' });
  await agent('a-creator', 'complete', { taskId: a.task.id, revision: 'broken-v1', result: { summary: 'done', evidence: 'claimed' } }, 409);
  assert.equal(projectInboxUpdates(store, meta).length, 0);
  await agent('a-creator', 'submit', { taskId: a.task.id, revision: 'fixed-v2' });
  await agent('a-reviewer', 'review', { taskId: a.task.id, revision: 'broken-v1', verdict: 'PASS', evidence: 'stale' }, 409);
  const largeReviewEvidence = `Browser replay passed: ${'x'.repeat(8_000)}`;
  await agent('a-reviewer', 'review', { taskId: a.task.id, revision: 'fixed-v2', verdict: 'PASS', evidence: largeReviewEvidence });
  await agent('a-creator', 'complete', { taskId: a.task.id, revision: 'fixed-v2', result: {
    summary: 'All win lines work', evidence: 'evidence/win-lines.json', wiki: 'wiki/win-lines.md' } });
  assert.equal(projectInboxUpdates(store, meta).length, 1);
  await agent('a-creator', 'add', { id: 'idea-1', title: 'A useful follow-up' });
  await agent('b-creator', 'add', { id: 'idea-2', title: 'Another follow-up' }, 409);
  const listing = await (await fetch(base + '/api/project-inboxes')).json();
  assert.equal(listing.projects.length, 1);
  assert.equal(listing.projects[0].tasks.length, 7);
  const listedTask = listing.projects[0].tasks.find(task => task.id === a.task.id);
  assert.deepEqual(Object.keys(listedTask).sort(), ['blockedReason', 'id', 'owner', 'revision', 'source', 'status', 'title', 'updatedAt']);
  assert.equal(listedTask.blockedReason, null);
  assert.equal(JSON.stringify(listing).includes(largeReviewEvidence), false, 'list omits large review and history payloads');
  for (const omitted of ['description', 'criteria', 'review', 'result', 'history']) assert.equal(omitted in listedTask, false);
  const detailResponse = await fetch(base + `/api/chats/a-creator/inbox/tasks/${a.task.id}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.review.evidence, largeReviewEvidence);
  assert.ok(detail.history.some(event => event.evidence === largeReviewEvidence));
  const unknownResponse = await fetch(base + '/api/chats/a-creator/inbox/tasks/missing');
  assert.equal(unknownResponse.status, 404);
  assert.deepEqual(await unknownResponse.json(), { error: 'Unknown task' });
  assert.ok(changes.length > 6);
});
