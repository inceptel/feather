import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { freePort } from './freePort.js';

// Solo-by-default chats, /auto start and stop, chat-owned schedules, and
// reviewer attach/detach, all against the real server with a fake tmux.
test('solo chats start, work, stop cleanly, own schedules, and gain or lose a reviewer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-auto-api-'));
  const home = path.join(root, 'home'), state = path.join(root, 'state'), bin = path.join(root, 'bin');
  for (const dir of [home, state, bin]) fs.mkdirSync(dir);
  const registry = path.join(root, 'panes');
  fs.writeFileSync(registry, '');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
case "$1" in
has-session) grep -qxF "$3" "$TMUX_REG"; exit $? ;;
list-sessions) while IFS= read -r n; do printf '%s|0\\n' "$n"; done < "$TMUX_REG" ;;
new-session) while [ $# -gt 0 ]; do if [ "$1" = '-s' ]; then printf '%s\\n' "$2" >> "$TMUX_REG"; fi; shift; done ;;
kill-session) while [ $# -gt 0 ]; do if [ "$1" = '-t' ]; then grep -vxF "$2" "$TMUX_REG" > "$TMUX_REG.n"; mv "$TMUX_REG.n" "$TMUX_REG"; fi; shift; done ;;
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
  const call = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const ok = async (method, url, body) => { const r = await call(method, url, body); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
  const meta = () => JSON.parse(fs.readFileSync(path.join(state, 'session-meta.json')));
  const panes = () => fs.readFileSync(registry, 'utf8');
  const bridge = async (id, body) => {
    const tokenFile = createHash('sha256').update(id).digest('hex');
    const response = await fetch(`${base}/api/internal/sessions/${id}/workflow`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Feather-Bridge-Token':
        fs.readFileSync(path.join(home, '.feather/omp-sessions/.feather-bridge-tokens', tokenFile), 'utf8') },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  await start();

  // 1. Solo by default: one session, no reviewer, no group, a solo prompt.
  const solo = await ok('POST', '/api/chats', { name: 'Solo Plan' });
  assert.equal(solo.reviewerSessionId, null);
  assert.equal(solo.groupId, null);
  assert.equal(solo.reviewPolicy, 'none');
  assert.equal(meta()[solo.id].chatRole, 'creator');
  assert.equal(meta()[solo.id].chatPair, null);
  assert.equal(Object.values(meta()).filter(entry => entry.chatRole === 'reviewer').length, 0);
  const promptDir = path.join(home, '.feather/session-system-prompts');
  const startup = id => fs.readFileSync(path.join(promptDir, fs.readdirSync(promptDir).find(name => name.startsWith(`${id}-`))), 'utf8');
  assert.match(startup(solo.id), /sole agent of a Feather chat/);
  assert.doesNotMatch(startup(solo.id), /sidecar post --group/);
  const status = await ok('GET', `/api/chats/${solo.id}/status`);
  assert.equal(status.status, 'ready');
  assert.equal((await ok('GET', '/api/sessions')).sessions.find(s => s.id === solo.id).chatPair, null);

  // 2. /auto start via the bridge (what the skill does), then stop restores the chat.
  const read = await bridge(solo.id, { action: 'read' });
  assert.equal(read.status, 200);
  assert.equal(meta()[solo.id].mode, undefined);
  await ok('POST', `/api/sessions/${solo.id}/send`, { text: 'Please keep working on the plan.' });
  const started = await bridge(solo.id, { action: 'start', generation: read.data.generation + 1, objective: 'Draft the plan', constraints: ['no spending'], next: 'Outline' });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.match(started.data.instructions, /sole agent/);
  assert.doesNotMatch(started.data.instructions, /Creator–Reviewer \(CR\) pair/);
  assert.equal(meta()[solo.id].mode, 'ralph');
  assert.equal(meta()[solo.id].autoModeBefore, null);
  assert.equal(meta()[solo.id].ralph.enabled, true);
  assert.ok((await ok('GET', '/api/sessions?mode=ralph')).sessions.some(s => s.id === solo.id));

  // 3. A chat-owned schedule, under the reserved `chats` room, is disabled by stop.
  const ruleBody = { target: { kind: 'session', sessionId: solo.id }, mode: 'inject', every: '24h', prompt: 'Post a standup.' };
  const rule = await ok('PUT', `/api/scheduler/rules/chats/${solo.id.slice(0, 8)}-standup`, ruleBody);
  assert.equal(rule.rule.ownerSessionId, solo.id);
  assert.equal(rule.rule.enabled, true);
  assert.equal((await call('PUT', '/api/scheduler/rules/chats/other', { ...ruleBody, target: { kind: 'session', sessionId: 'no-such-session-1' } })).status, 404);
  assert.equal((await call('PUT', '/api/scheduler/rules/chats/leader', { target: { kind: 'leader' }, mode: 'fresh', every: '24h' })).status, 400);
  assert.equal((await call('PUT', '/api/scheduler/rules/nowhere/x', ruleBody)).status, 404, 'a chat rule cannot live in a Room namespace');
  const stopped = await bridge(solo.id, { action: 'stop' });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  assert.equal(stopped.data.enabled, false);
  let entry = meta()[solo.id];
  assert.equal(entry.mode, undefined, 'stop restores the pre-/auto mode');
  assert.equal(entry.autoModeBefore, undefined);
  assert.equal(entry.ralph.enabled, false);
  assert.equal(entry.autoLifecycle, 1);
  assert.ok(entry.autoStopNote && ['delivered', 'unobserved'].includes(entry.autoStopNote.status), JSON.stringify(entry.autoStopNote));
  const rules = (await ok('GET', '/api/scheduler?room=chats')).rules;
  assert.equal(rules.find(r => r.id === `chats/${solo.id.slice(0, 8)}-standup`).enabled, false, 'stop disables owned schedules');
  assert.ok(!(await ok('GET', '/api/sessions?mode=ralph')).sessions.some(s => s.id === solo.id));
  await ok('DELETE', `/api/scheduler/rules/chats/${solo.id.slice(0, 8)}-standup`);

  // 4. A stop on a dormant chat sends no note and does not resume the pane.
  await ok('POST', `/api/sessions/${solo.id}/workflow`, { action: 'start', objective: 'Draft the plan', constraints: [], next: 'Outline' });
  assert.equal(meta()[solo.id].mode, 'ralph');
  fs.writeFileSync(registry, panes().split('\n').filter(line => line !== `feather-${solo.id.slice(0, 8)}`).join('\n'));
  await ok('POST', `/api/sessions/${solo.id}/ralph`, { enabled: false });
  entry = meta()[solo.id];
  assert.equal(entry.mode, undefined);
  assert.equal(entry.autoLifecycle, 2);
  assert.equal(entry.autoStopNote.status, 'unobserved', 'note recorded from the previous stop only');
  assert.ok(!panes().includes(solo.id.slice(0, 8)), 'the stop note must not resume a dormant pane');

  // 5. A chat born in ralph mode keeps it after stop.
  const born = await ok('POST', '/api/chats', { name: 'Born Ralph', mode: 'ralph' });
  assert.equal(born.reviewerSessionId, null);
  assert.equal(meta()[born.id].mode, 'ralph');
  await ok('POST', `/api/sessions/${born.id}/ralph`, { enabled: false });
  assert.equal(meta()[born.id].mode, 'ralph');
  assert.equal(meta()[born.id].ralph.enabled, false);

  // 6. Attach a reviewer to the solo chat, idempotently; then detach it.
  fs.appendFileSync(registry, `feather-${solo.id.slice(0, 8)}\n`);
  const attached = await ok('POST', `/api/chats/${solo.id}/reviewer`, { reviewPolicy: 'adaptive', reviewerAgent: 'claude' });
  assert.equal(attached.attached, true);
  assert.ok(attached.chatPair?.reviewerSessionId && attached.chatPair.groupId);
  assert.equal(attached.reviewPolicy, 'adaptive');
  assert.equal(attached.delivery.reviewer.submitted, true);
  assert.equal(attached.delivery.creator.submitted, true);
  entry = meta()[solo.id];
  assert.equal(entry.chatPair.reviewerSessionId, attached.chatPair.reviewerSessionId);
  assert.equal(entry.chatReviewerAttach, undefined);
  const reviewer = meta()[attached.chatPair.reviewerSessionId];
  assert.equal(reviewer.chatRole, 'reviewer');
  assert.equal(reviewer.chatPair.creatorSessionId, solo.id);
  assert.ok(panes().includes(attached.chatPair.reviewerSessionId.slice(0, 8)), 'reviewer harness launched');
  assert.match(startup(attached.chatPair.reviewerSessionId), /Reviewer/);
  const group = await ok('GET', `/api/sidecar/${attached.chatPair.groupId}`);
  assert.equal(group.group.durable, true);
  const again = await ok('POST', `/api/chats/${solo.id}/reviewer`, {});
  assert.equal(again.attached, false);
  assert.equal(again.chatPair.reviewerSessionId, attached.chatPair.reviewerSessionId);
  assert.equal(Object.values(meta()).filter(e => e.chatRole === 'reviewer' && !e.chatDetachedAt).length, 1, 'never a second reviewer');
  assert.equal((await call('POST', `/api/chats/${attached.chatPair.reviewerSessionId}/reviewer`, {})).status, 404);
  assert.equal((await call('POST', `/api/chats/${solo.id}/reviewer`, { reviewPolicy: 'bogus' })).status, 200, 'already paired short-circuits before validation');
  const detached = await ok('DELETE', `/api/chats/${solo.id}/reviewer`);
  assert.equal(detached.detached, true);
  assert.equal(detached.chatPair, null);
  assert.equal(detached.reviewPolicy, 'none');
  entry = meta()[solo.id];
  assert.equal(entry.chatPair, null);
  assert.equal(entry.reviewPolicy, 'none');
  assert.ok(entry.chatReviewerDetachedAt);
  assert.ok(meta()[attached.chatPair.reviewerSessionId].chatDetachedAt);
  assert.ok(!panes().includes(attached.chatPair.reviewerSessionId.slice(0, 8)), 'reviewer harness killed');
  assert.equal((await ok('GET', `/api/sidecar/${attached.chatPair.groupId}`)).group.status, 'done', 'group torn down');
  assert.equal((await call('DELETE', `/api/chats/${solo.id}/reviewer`)).data.detached, false, 'detach is idempotent');
  assert.equal((await call('POST', `/api/chats/${solo.id}/reviewer`, { reviewPolicy: 'bogus' })).status, 400);

  // 7. Deleting the chat while a reviewer is still priming cancels the attempt and leaves no pair.
  const victim = await ok('POST', '/api/chats', { name: 'Victim' });
  const inflight = call('POST', `/api/chats/${victim.id}/reviewer`, { reviewerAgent: 'claude' });
  for (let n = 0; n < 100 && !meta()[victim.id]?.chatReviewerAttach; n++) await new Promise(resolve => setTimeout(resolve, 10));
  const pending = meta()[victim.id].chatReviewerAttach;
  assert.ok(pending?.reviewerSessionId, 'attempt recorded durably before priming');
  assert.equal((await call('POST', `/api/chats/${victim.id}/reviewer`, {})).status, 409, 'a second attach while one is in flight');
  await ok('POST', `/api/sessions/${victim.id}/delete`, {});
  const result = await inflight;
  assert.ok([409, 503].includes(result.status), JSON.stringify(result.data));
  assert.equal(meta()[victim.id], undefined);
  assert.ok(!meta()[pending.reviewerSessionId] || meta()[pending.reviewerSessionId].chatDetachedAt, 'pending reviewer not left behind');
  assert.ok(!panes().includes(pending.reviewerSessionId.slice(0, 8)), 'pending reviewer harness killed');

  // 8. Boot sweep: a pending attempt left by a crash is cleaned up on restart.
  const orphan = await ok('POST', '/api/chats', { name: 'Orphan' });
  await stop();
  const all = meta();
  all[orphan.id].chatReviewerAttach = { token: 'stale', reviewerSessionId: 'stale-reviewer-0000', groupId: null, startedAt: new Date().toISOString() };
  all['stale-reviewer-0000'] = { chatRole: 'reviewer', chatPair: { creatorSessionId: orphan.id, reviewerSessionId: 'stale-reviewer-0000', groupId: null }, agent: 'claude' };
  fs.writeFileSync(path.join(state, 'session-meta.json'), JSON.stringify(all));
  await start();
  assert.equal(meta()[orphan.id].chatReviewerAttach, undefined, 'boot sweep clears the pending attempt');
  assert.equal(meta()[orphan.id].chatPair, null);
  assert.ok(!meta()['stale-reviewer-0000'] || meta()['stale-reviewer-0000'].chatDetachedAt);
  assert.equal(meta()[solo.id].mode, undefined, 'restored mode survives restart');
});
