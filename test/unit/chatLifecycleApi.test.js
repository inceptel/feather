import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { freePort } from './freePort.js';

test('CR chats share projects, survive server restart, and preserve Stop through peer feedback', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-chat-api-'));
  const home = path.join(root, 'home'), state = path.join(root, 'state'), bin = path.join(root, 'bin');
  for (const dir of [home, state, bin]) fs.mkdirSync(dir);
  const registry = path.join(root, 'panes');
  fs.writeFileSync(registry, '');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
case "$1" in
has-session) grep -qxF "$3" "$TMUX_REG"; exit $? ;;
list-sessions) while IFS= read -r n; do printf '%s|0\\n' "$n"; done < "$TMUX_REG" ;;
new-session) while [ $# -gt 0 ]; do if [ "$1" = '-s' ]; then printf '%s\\n' "$2" >> "$TMUX_REG"; fi; shift; done ;;
esac
exit 0
`, { mode: 0o755 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  let child, logs = '';
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: home, FEATHER_STATE_DIR: state, PORT: String(port),
        FEATHER_ROOM_PULSES: '0', FEATHER_SCHEDULER: '0', FEATHER_TMUX_READY_TIMEOUT_MS: '20',
        PATH: `${bin}:${process.env.PATH}`, TMUX_REG: registry },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', chunk => { logs += chunk; });
    for (let n = 0; n < 100; n++) {
      if (child.exitCode !== null) throw new Error(logs);
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Server did not start: ${logs}`);
  }
  async function stop() { if (child?.exitCode === null) { child.kill(); await once(child, 'exit'); } }
  t.after(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const post = async (url, body) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };
  const meta = () => JSON.parse(fs.readFileSync(path.join(state, 'session-meta.json')));
  const inbox = async (id, action, input = {}) => {
    const tokenFile = createHash('sha256').update(id).digest('hex');
    const response = await fetch(`${base}/api/internal/sessions/${id}/inbox`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Feather-Bridge-Token':
        fs.readFileSync(path.join(home, '.feather/omp-sessions/.feather-bridge-tokens', tokenFile), 'utf8') },
      body: JSON.stringify({ action, ...input }),
    });
    const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
  };
  await start();
  const a = await post('/api/chats', { name: 'Strategy A', mode: 'ralph', reviewerAgent: 'claude' });
  const b = await post('/api/chats', { name: 'Strategy B', projectSessionId: a.id, reviewerAgent: 'claude' });
  const startup = id => { const dir = path.join(home, '.feather/session-system-prompts'); return fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(name => name.startsWith(`${id}-`))), 'utf8'); };
  assert.match(startup(a.id), /Chat naming: after the first meaningful user message/);
  assert.doesNotMatch(startup(a.reviewerSessionId), /Chat naming:/);
  await post(`/api/sessions/${a.id}/rename`, { title: 'Tic Tac Toe Rules' });
  assert.equal(meta()[a.id].title, 'Tic Tac Toe Rules');
  assert.equal(meta()[a.id].cwd, a.cwd, 'Display naming must not move the project');
  assert.equal(meta()[a.reviewerSessionId].title, 'Reviewer: Strategy A');
  assert.equal(a.cwd, b.cwd);
  await post(`/api/chats/${a.id}/inbox/config`, { objective: 'Build tic tac toe', allowIdeas: false });
  await post(`/api/chats/${a.id}/inbox/tasks`, { id: 'board', title: 'Playable board' });
  await post(`/api/chats/${b.id}/inbox/tasks`, { id: 'scores', title: 'Scoreboard' });
  const claims = await Promise.all([inbox(a.id, 'claim'), inbox(b.id, 'claim')]);
  assert.notEqual(claims[0].task.id, claims[1].task.id);
  fs.writeFileSync(path.join(a.cwd, 'evidence.txt'), 'retained');
  await post(`/api/chat-pins/${a.id}`, { pinned: true, title: 'Trading' });
  const renamed = await post(`/api/chats/${a.id}/project/rename`, { name: 'Trading' });
  assert.equal(meta()[b.id].cwd, renamed.cwd);
  await post(`/api/scheduler/chats/${a.id}/stop`, {});
  await stop();
  await start();
  assert.equal(meta()[a.id].ralph.enabled, false);
  assert.equal((await inbox(a.id, 'claim')).task.id, claims[0].task.id, 'claim survives rename and server restart');
  assert.equal((await inbox(b.id, 'claim')).task.id, claims[1].task.id);
  assert.equal(fs.readFileSync(path.join(a.cwd, 'evidence.txt'), 'utf8'), 'retained');
  const pins = await (await fetch(`${base}/api/chat-pins`)).json();
  assert.ok(pins.pins.some(pin => pin.id === a.id));
  const group = await (await fetch(`${base}/api/sidecar/${a.groupId}`)).json();
  assert.equal(group.group.durable, true);
  fs.writeFileSync(registry, fs.readFileSync(registry, 'utf8').split('\n').filter(line => line !== `feather-${a.id.slice(0, 8)}`).join('\n'));
  await post(`/api/sidecar/${a.groupId}/post`, { from: 'reviewer', to: 'creator', text: 'PASS: fixture review.' });
  assert.equal(meta()[a.id].ralph.enabled, false, 'peer feedback cannot restart stopped Ralph');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(!fs.readFileSync(registry, 'utf8').includes(a.id.slice(0, 8)), 'peer feedback cannot launch a stopped Creator');
  await post(`/api/sessions/${a.id}/send`, { text: 'Continue the task.' });
  assert.equal(meta()[a.id].ralph.enabled, true);
  assert.ok(fs.readFileSync(registry, 'utf8').includes(a.reviewerSessionId.slice(0, 8)), 'Stop retained Reviewer');
});
