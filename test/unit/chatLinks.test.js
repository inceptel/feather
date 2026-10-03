import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { createChatLinks, installChatLinkRoutes, normalizeLinkTarget, hasFrontPage, MAX_LINKS } from '../../lib/chat-links.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-links-'));
  const page = path.join(root, 'status.html');
  fs.writeFileSync(page, '<p>ok</p>');
  let meta = { driver: { title: 'Driver' }, peer: {}, other: {} };
  // 'peer' is a live sidecar of 'driver'; 'other' drives nothing.
  const links = createChatLinks({ readMeta: () => meta, updateMeta: fn => { meta = fn(meta); return meta; }, home: root,
    sidecarDriverOf: id => id === 'peer' ? 'driver' : null });
  const changes = [];
  const app = express(); app.use(express.json());
  installChatLinkRoutes(app, { links, tokenValid: (id, value) => value === `token-${id}`, changed: id => changes.push(id) });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.close(); server.closeAllConnections(); await once(server, 'close'); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, body, { token, status = 200, method = 'POST' } = {}) {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Feather-Bridge-Token': token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await res.json();
    assert.equal(res.status, status, JSON.stringify(result));
    return result;
  }
  const agent = (caller, body, status, token = `token-${caller}`) => request(`/api/internal/sessions/${caller}/links`, body, { token, status });
  const get = id => request(`/api/chats/${id}/links`, null, { method: 'GET' });
  return { root, page, meta: () => meta, agent, get, request, changes };
}

test('an agent adds, updates and removes links on its own chat only', async t => {
  const f = await fixture(t);
  await f.agent('driver', { action: 'add', label: 'Status', target: f.page });
  await f.agent('driver', { action: 'add', label: 'Site', target: 'https://example.com/a' });
  const updated = await f.agent('driver', { action: 'add', label: 'Status page', target: f.page });
  assert.deepEqual(updated.links.map(link => [link.label, link.kind]), [['Status page', 'file'], ['Site', 'web']]);
  assert.equal(typeof updated.links[0].mtimeMs, 'number');

  // Wrong token, another chat's token, and naming another chat all fail.
  await f.agent('driver', { action: 'add', target: f.page }, 403, 'nope');
  await f.agent('driver', { action: 'remove', target: f.page }, 403, 'token-other');
  await f.agent('other', { action: 'add', target: f.page, chat: 'driver' }, 403);
  await f.agent('other', { action: 'add', target: f.page, front: true, chat: 'driver' }, 403);
  assert.equal(f.meta().other.links, undefined);

  await f.agent('driver', { action: 'remove', target: 'https://example.com/a' });
  await f.agent('driver', { action: 'remove', target: 'https://example.com/a' }, 404);
  assert.deepEqual((await f.get('driver')).links.map(link => link.target), [f.page]);
  assert.deepEqual(f.changes, ['driver', 'driver', 'driver', 'driver']);
});

test('a sidecar may set its driver\'s front page and nothing else there', async t => {
  const f = await fixture(t);
  await f.agent('driver', { action: 'add', label: 'Notes', target: '/tmp/notes.md' });
  const set = await f.agent('peer', { action: 'add', label: 'Dashboard', target: f.page, front: true, chat: 'driver' });
  assert.equal(set.chat, 'driver');
  assert.deepEqual(set.links.filter(link => link.front).map(link => link.target), [f.page]);
  assert.equal(f.meta().peer.links, undefined);
  await f.agent('peer', { action: 'add', label: 'Extra', target: '/tmp/x.md', chat: 'driver' }, 403);
  await f.agent('peer', { action: 'remove', target: '/tmp/notes.md', chat: 'driver' }, 403);
  await f.agent('peer', { action: 'clear-front', chat: 'driver' }, 403);
  assert.equal((await f.agent('peer', { action: 'read', chat: 'driver' })).links.length, 2);
  // The peer still owns its own list.
  await f.agent('peer', { action: 'add', target: '/tmp/peer.md' });
  assert.equal(f.meta().peer.links.length, 1);
});

test('a chat has at most one front page', async t => {
  const f = await fixture(t);
  const second = path.join(f.root, 'second.md');
  await f.agent('driver', { action: 'add', target: f.page, front: true });
  await f.agent('driver', { action: 'add', target: second, front: true });
  let links = (await f.get('driver')).links;
  assert.deepEqual(links.filter(link => link.front).map(link => link.target), [second]);
  assert.equal(links.find(link => link.target === second).missing, true);
  // Updating a label keeps the front page; front:false clears it.
  await f.agent('driver', { action: 'add', label: 'Renamed', target: second });
  assert.ok(hasFrontPage(f.meta().driver));
  await f.agent('driver', { action: 'add', target: second, front: false });
  assert.ok(!hasFrontPage(f.meta().driver));
  await f.agent('driver', { action: 'add', target: f.page, front: true });
  await f.agent('driver', { action: 'clear-front' });
  links = (await f.get('driver')).links;
  assert.equal(links.length, 2);
  assert.ok(!links.some(link => link.front));
});

test('bad targets and labels are rejected without changing the list', async t => {
  const f = await fixture(t);
  for (const target of ['', 'notes.md', './notes.md', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/x', 'data:text/html,hi',
    'https://user:pw@example.com/', 'http://', '/tmp/a\nb', 42, undefined, 'x'.repeat(3000)]) {
    await f.agent('driver', { action: 'add', label: 'Bad', target }, 400);
  }
  await f.agent('driver', { action: 'add', target: 'https://example.com', front: true }, 400);
  await f.agent('driver', { action: 'add', target: f.page, label: 'x'.repeat(81) }, 400);
  await f.agent('driver', { action: 'add', target: f.page, front: 'yes' }, 400);
  await f.agent('driver', { action: 'launch' }, 400);
  assert.equal(f.meta().driver.links, undefined);

  // Paths normalise, ~ expands, and a missing label falls back to the name.
  const result = await f.agent('driver', { action: 'add', target: '~/a/../status.html' });
  assert.deepEqual(result.links.map(link => [link.label, link.target]), [['status.html', f.page]]);
  assert.equal(normalizeLinkTarget('https://Example.com', f.root).target, 'https://example.com/');

  for (let n = 1; n < MAX_LINKS; n++) await f.agent('driver', { action: 'add', target: `/tmp/link-${n}` });
  await f.agent('driver', { action: 'add', target: '/tmp/one-too-many' }, 409);
});

test('the user removes and reorders links; a stale order is refused', async t => {
  const f = await fixture(t);
  for (const name of ['a', 'b', 'c']) await f.agent('driver', { action: 'add', target: `/tmp/${name}` });
  const ordered = await f.request('/api/chats/driver/links/order', { targets: ['/tmp/c', '/tmp/a', '/tmp/b'] });
  assert.deepEqual(ordered.links.map(link => link.target), ['/tmp/c', '/tmp/a', '/tmp/b']);
  await f.request('/api/chats/driver/links/order', { targets: ['/tmp/c', '/tmp/a'] }, { status: 409 });
  await f.request('/api/chats/driver/links/order', { targets: ['/tmp/c', '/tmp/a', '/tmp/a'] }, { status: 409 });
  const removed = await f.request('/api/chats/driver/links/remove', { target: '/tmp/a' });
  assert.deepEqual(removed.links.map(link => link.target), ['/tmp/c', '/tmp/b']);
  await f.request('/api/chats/driver/links/remove', { target: '/tmp/a' }, { status: 404 });
  await f.request('/api/chats/driver/links/remove', { target: '/tmp/b' });
  await f.request('/api/chats/driver/links/remove', { target: '/tmp/c' });
  assert.equal(f.meta().driver.links, undefined);
  assert.equal(f.meta().driver.title, 'Driver');
});
