import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { freePort } from './freePort.js';
import { stopChild } from './stopChild.js';
import { NO_TMUX_PATH } from './noTmux.js';

// The real server: bridge tokens decide who may write, a live sidecar group
// lets its peer set the driver's front page, and the chat list marks it.
test('server links: own chat only, live sidecar sets its driver\'s front page, Chats list marks it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-links-api-'));
  const home = path.join(root, 'home'), state = path.join(root, 'state');
  const featherHome = path.join(home, '.feather');
  const tokens = path.join(featherHome, 'omp-sessions', '.feather-bridge-tokens');
  const sidecars = path.join(featherHome, 'sidecars');
  for (const dir of [state, tokens, sidecars]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ids = { driver: '11111111-1111-4111-8111-111111111111', peer: '22222222-2222-4222-8222-222222222222', ended: '33333333-3333-4333-8333-333333333333' };
  for (const id of Object.values(ids)) {
    fs.writeFileSync(path.join(tokens, createHash('sha256').update(id).digest('hex')), `token-${id}`, { mode: 0o600 });
  }
  const created = new Date().toISOString();
  fs.writeFileSync(path.join(state, 'session-meta.json'), JSON.stringify({
    [ids.driver]: { title: 'Driver chat', agent: 'claude', chatRole: 'creator', chatStartup: { status: 'ready' }, chatCreatedAt: created },
  }), { mode: 0o600 });
  const member = (sessionId, role, spawned) => ({ sessionId, role, spawned });
  fs.writeFileSync(path.join(sidecars, 'groups.json'), JSON.stringify({
    live: { id: 'live', kind: 'sidecar', status: 'active', members: [member(ids.driver, 'driver', false), member(ids.peer, 'dashboard', true)] },
    old: { id: 'old', kind: 'sidecar', status: 'ended', members: [member(ids.driver, 'driver', false), member(ids.ended, 'dashboard', true)] },
  }));
  const page = path.join(root, 'status.html');
  fs.writeFileSync(page, '<h1>Status</h1>');
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { HOME: home, FEATHER_STATE_DIR: state, PORT: String(port), FEATHER_ROOM_PULSES: '0', FEATHER_SCHEDULER: '0', PATH: NO_TMUX_PATH, LANG: 'C.UTF-8' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => { await stopChild(child); fs.rmSync(root, { recursive: true, force: true }); });
  for (let n = 0; ; n++) {
    if (child.exitCode !== null || n > 100) throw new Error(`Server did not start: ${logs}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  async function agent(caller, body, status, token = `token-${caller}`) {
    const res = await fetch(`${base}/api/internal/sessions/${caller}/links`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Feather-Bridge-Token': token }, body: JSON.stringify(body) });
    const result = await res.json();
    assert.equal(res.status, status, JSON.stringify(result));
    return result;
  }
  const listed = async () => (await (await fetch(`${base}/api/sessions?limit=20`)).json()).sessions.find(s => s.id === ids.driver);

  assert.equal((await listed()).frontPage, undefined);
  await agent(ids.driver, { action: 'add', label: 'Docs', target: 'https://example.com/docs' }, 200);
  await agent(ids.peer, { action: 'add', label: 'Docs', target: 'https://example.com/x' , chat: ids.driver }, 403);
  await agent(ids.ended, { action: 'add', label: 'Old', target: page, front: true, chat: ids.driver }, 403);
  await agent(ids.driver, { action: 'add', target: page, front: true }, 403, `token-${ids.peer}`);
  const set = await agent(ids.peer, { action: 'add', label: 'Dashboard', target: page, front: true, chat: ids.driver }, 200);
  assert.deepEqual(set.links.map(link => [link.label, !!link.front]), [['Docs', false], ['Dashboard', true]]);

  assert.equal((await listed()).frontPage, true);
  const links = await (await fetch(`${base}/api/chats/${ids.driver}/links`)).json();
  assert.equal(links.links[1].target, page);
  assert.equal(typeof links.links[1].mtimeMs, 'number');
  await agent(ids.driver, { action: 'clear-front' }, 200);
  assert.equal((await listed()).frontPage, undefined);
});
