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
  // The fake tmux keeps a pane registry, dumps its environment on new-session
  // and logs every paste. A pane normally captures as a constant screen; while
  // "$TMUX_REG.hold.<target>" exists its screen keeps changing, so the server's
  // async settle wait (waitForPaneSettled) parks there without blocking the
  // event loop, and a test can act while a reviewer is still priming.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
target=''; prev=''
for a in "$@"; do if [ "$prev" = '-t' ]; then target="$a"; fi; prev="$a"; done
case "$1" in
has-session) grep -qxF "$target" "$TMUX_REG"; exit $? ;;
list-sessions) while IFS= read -r n; do printf '%s|0\\n' "$n"; done < "$TMUX_REG" ;;
new-session) name=''; prev=''; for a in "$@"; do if [ "$prev" = '-s' ]; then name="$a"; fi; prev="$a"; done
  printf '%s\\n' "$name" >> "$TMUX_REG"; { env; printf 'ARGS=%s\\n' "$*"; } > "$TMUX_REG.env.$name" ;;
kill-session) grep -vxF "$target" "$TMUX_REG" > "$TMUX_REG.n"; mv "$TMUX_REG.n" "$TMUX_REG" ;;
capture-pane) if [ -e "$TMUX_REG.hold.$target" ]; then date +%s%N; else echo ready; fi ;;
load-buffer) cat "$4" > "$TMUX_REG.buf.$3" 2>/dev/null || true ;;
paste-buffer) name=''; prev=''; for a in "$@"; do if [ "$prev" = '-b' ]; then name="$a"; fi; prev="$a"; done
  { printf '%s\\t' "$target"; base64 -w0 < "$TMUX_REG.buf.$name"; printf '\\n'; } >> "$TMUX_REG.pastes" ;;
esac
exit 0
`, { mode: 0o755 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  // Sentinels that must never reach the server or the harnesses it launches.
  const sentinels = { TMUX: '/tmp/sentinel-tmux,1,0', TMUX_PANE: '%99', FEATHER_URL: 'http://sentinel.invalid', FEATHER_WIKI_DIR: '/sentinel-wiki', FEATHER_UPLOAD_DIR: '/sentinel-uploads' };
  Object.assign(process.env, sentinels);
  let child, logs = '';
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      // Allowlisted child environment: nothing from the caller's shell or an
      // enclosing Feather/tmux leaks into the server under test.
      env: { HOME: home, FEATHER_STATE_DIR: state, PORT: String(port),
        FEATHER_ROOM_PULSES: '0', FEATHER_SCHEDULER: '0', FEATHER_TMUX_READY_TIMEOUT_MS: '6000',
        PATH: `${bin}:${process.env.PATH}`, TMUX_REG: registry, LANG: 'C.UTF-8' },
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
  t.after(async () => { await stop(); for (const key of Object.keys(sentinels)) delete process.env[key]; fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const ok = async (method, url, body) => { const r = await call(method, url, body); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
  const meta = () => JSON.parse(fs.readFileSync(path.join(state, 'session-meta.json')));
  const panes = () => fs.readFileSync(registry, 'utf8');
  const pane = id => `feather-${id.slice(0, 8)}`;
  const pastes = id => fs.existsSync(`${registry}.pastes`) ? fs.readFileSync(`${registry}.pastes`, 'utf8').split('\n').filter(line => line.startsWith(`${pane(id)}\t`)).map(line => Buffer.from(line.slice(pane(id).length + 1), 'base64').toString('utf8')) : [];
  const hold = id => fs.writeFileSync(`${registry}.hold.${pane(id)}`, '');
  const release = id => fs.rmSync(`${registry}.hold.${pane(id)}`, { force: true });
  const until = async (probe, what) => { for (let n = 0; n < 2000; n++) { const value = probe(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error(`timed out waiting for ${what}`); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const bridge = async (id, body) => {
    const tokenFile = createHash('sha256').update(id).digest('hex');
    const response = await fetch(`${base}/api/internal/sessions/${id}/workflow`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Feather-Bridge-Token':
        fs.readFileSync(path.join(home, '.feather/omp-sessions/.feather-bridge-tokens', tokenFile), 'utf8') },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const inbox = async (id, body) => {
    const tokenFile = createHash('sha256').update(id).digest('hex');
    const response = await fetch(`${base}/api/internal/sessions/${id}/inbox`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Feather-Bridge-Token':
        fs.readFileSync(path.join(home, '.feather/omp-sessions/.feather-bridge-tokens', tokenFile), 'utf8') },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const promptDir = path.join(home, '.feather/session-system-prompts');
  const startup = id => fs.readFileSync(path.join(promptDir, fs.readdirSync(promptDir).find(name => name.startsWith(`${id}-`))), 'utf8');
  await start();

  // 1. Solo by default: one session, no reviewer, no group, a solo prompt, no project inbox.
  const solo = await ok('POST', '/api/chats', { name: 'Solo Plan' });
  assert.equal(solo.reviewerSessionId, null);
  assert.equal(solo.groupId, null);
  assert.equal(solo.reviewPolicy, 'none');
  assert.equal(meta()[solo.id].chatRole, 'creator');
  assert.equal(meta()[solo.id].chatPair, null);
  assert.equal(Object.values(meta()).filter(entry => entry.chatRole === 'reviewer').length, 0);
  assert.match(startup(solo.id), /sole agent of a Feather chat/);
  assert.match(startup(solo.id), /This chat has no project inbox/);
  assert.doesNotMatch(startup(solo.id), /sidecar post --group|Project inbox CLI|claim \{\}/);
  const status = await ok('GET', `/api/chats/${solo.id}/status`);
  assert.equal(status.status, 'ready');
  assert.equal((await ok('GET', '/api/sessions')).sessions.find(s => s.id === solo.id).chatPair, null);
  const soloInbox = await call('GET', `/api/chats/${solo.id}/inbox`);
  assert.equal(soloInbox.status, 409, JSON.stringify(soloInbox.data));
  assert.match(soloInbox.data.error, /no Reviewer, so it has no project inbox/);
  assert.equal((await inbox(solo.id, { action: 'read' })).status, 409, 'the agent CLI gets the same answer');
  assert.ok(!(await ok('GET', '/api/project-inboxes')).projects.some(p => p.sessionId === solo.id), 'solo chats are not listed as CR projects');
  // Environment isolation: the harness env comes from the server, not this test process.
  const harnessEnv = fs.readFileSync(`${registry}.env.${pane(solo.id)}`, 'utf8');
  for (const [key, value] of Object.entries(sentinels)) assert.ok(!harnessEnv.includes(value), `${key} sentinel leaked into the harness environment`);
  assert.ok(new RegExp(`FEATHER_URL=\\S*127\\.0\\.0\\.1:${port}`).test(harnessEnv.replace(/'"'"'/g, '')), 'the harness gets this server as FEATHER_URL');
  assert.doesNotMatch(startup(solo.id), /sentinel-wiki/);

  // 2. /auto via the bridge (what the skill does): start, same objective, changed
  //    objective, stale generation, stop, start refused until a human speaks, start again.
  const read = await bridge(solo.id, { action: 'read' });
  assert.equal(read.status, 200);
  assert.equal(meta()[solo.id].mode, undefined);
  await ok('POST', `/api/sessions/${solo.id}/send`, { text: 'Please keep working on the plan.' });
  const gen = read.data.generation + 1;
  const started = await bridge(solo.id, { action: 'start', generation: gen, objective: 'Draft the plan', constraints: ['no spending'], next: 'Outline' });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.match(started.data.instructions, /sole agent/);
  assert.doesNotMatch(started.data.instructions, /Creator–Reviewer \(CR\) pair/);
  assert.equal(started.data.generation, gen);
  assert.equal(meta()[solo.id].mode, 'ralph');
  assert.equal(meta()[solo.id].autoModeBefore, null);
  assert.equal(meta()[solo.id].ralph.enabled, true);
  assert.ok((await ok('GET', '/api/sessions?mode=ralph')).sessions.some(s => s.id === solo.id));
  const firstUpdatedAt = meta()[solo.id].workflow.updatedAt;
  const same = await bridge(solo.id, { action: 'start', generation: gen, objective: 'Draft the plan', constraints: ['no spending'], next: 'Outline' });
  assert.equal(same.status, 200);
  assert.equal(meta()[solo.id].workflow.updatedAt, firstUpdatedAt, 'same objective is a no-op');
  const changed = await bridge(solo.id, { action: 'start', generation: gen, objective: 'Draft and cost the plan', constraints: ['no spending'], next: 'Outline' });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.objective, 'Draft and cost the plan');
  assert.equal(meta()[solo.id].mode, 'ralph');
  assert.equal((await bridge(solo.id, { action: 'start', generation: gen - 1, objective: 'Something else' })).status, 409, 'a stale generation never starts');
  const stopped1 = await bridge(solo.id, { action: 'stop' });
  assert.equal(stopped1.status, 200);
  assert.equal(stopped1.data.enabled, false);
  assert.equal(stopped1.data.generation, gen + 1);
  assert.equal(meta()[solo.id].mode, undefined, 'stop restores the ordinary mode');
  assert.equal(meta()[solo.id].autoLifecycle, 1);
  assert.ok(pastes(solo.id).some(text => text.startsWith('Ongoing work stopped.')), 'the stop note reached the creator pane');
  const stoppedRow = (await ok('GET', '/api/sessions')).sessions.find(s => s.id === solo.id);
  assert.equal(stoppedRow.mode, undefined);
  assert.equal(stoppedRow.auto?.lifecycle, 1, 'a stopped auto keeps a public history marker');
  assert.ok(stoppedRow.auto.stoppedAt);
  const refused = await bridge(solo.id, { action: 'start', generation: gen + 1, objective: 'Draft the plan' });
  assert.equal(refused.status, 409, 'no restart without a new human instruction');
  assert.match(refused.data.error, /human instruction/);
  await ok('POST', `/api/sessions/${solo.id}/send`, { text: 'Go on.' });
  const read2 = await bridge(solo.id, { action: 'read' });
  const restarted = await bridge(solo.id, { action: 'start', generation: read2.data.generation, objective: 'Draft the plan', constraints: [], next: 'Outline' });
  assert.equal(restarted.status, 200, JSON.stringify(restarted.data));
  assert.equal(meta()[solo.id].mode, 'ralph');
  assert.equal(meta()[solo.id].autoModeBefore, null);

  // 3. Chat-owned schedules under the reserved `chats` room: a rule-only stop leaves
  //    the chat working; an owner stop disables every owned rule; ownership persists.
  const ruleName = `${solo.id.slice(0, 8)}-standup`, ruleId = `chats/${ruleName}`;
  const ruleBody = { target: { kind: 'session', sessionId: solo.id }, mode: 'inject', every: '24h', prompt: 'Post a standup.' };
  const rule = await ok('PUT', `/api/scheduler/rules/chats/${ruleName}`, ruleBody);
  assert.equal(rule.rule.ownerSessionId, solo.id);
  assert.equal(rule.rule.enabled, true);
  assert.equal((await call('PUT', '/api/scheduler/rules/chats/other', { ...ruleBody, target: { kind: 'session', sessionId: 'no-such-session-1' } })).status, 404);
  assert.equal((await call('PUT', '/api/scheduler/rules/chats/leader', { target: { kind: 'leader' }, mode: 'fresh', every: '24h' })).status, 400);
  assert.equal((await call('PUT', '/api/scheduler/rules/nowhere/x', ruleBody)).status, 404, 'a chat rule cannot live in a Room namespace');
  const findRule = async () => (await ok('GET', '/api/scheduler?room=chats')).rules.find(r => r.id === ruleId);
  await ok('POST', `/api/scheduler/rules/chats/${ruleName}/stop`);
  assert.equal((await findRule()).enabled, false, 'rule-only stop disables the rule');
  assert.equal(meta()[solo.id].mode, 'ralph', 'rule-only stop leaves the chat working');
  assert.equal(meta()[solo.id].ralph.enabled, true);
  await ok('POST', `/api/scheduler/rules/chats/${ruleName}/resume`);
  assert.equal((await findRule()).enabled, true);
  const stopped = await bridge(solo.id, { action: 'stop' });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  let entry = meta()[solo.id];
  assert.equal(entry.mode, undefined, 'stop restores the pre-/auto mode');
  assert.equal(entry.autoModeBefore, undefined);
  assert.equal(entry.ralph.enabled, false);
  assert.equal(entry.autoLifecycle, 2);
  assert.ok(entry.autoStopNote && ['delivered', 'unobserved'].includes(entry.autoStopNote.status), JSON.stringify(entry.autoStopNote));
  assert.equal((await findRule()).enabled, false, 'stop disables owned schedules');
  assert.equal((await findRule()).ownerSessionId, solo.id, 'ownership survives the stop');
  assert.ok(!(await ok('GET', '/api/sessions?mode=ralph')).sessions.some(s => s.id === solo.id));
  await ok('POST', `/api/scheduler/rules/chats/${ruleName}/resume`);
  assert.equal((await findRule()).enabled, true, 'a resumed rule is independent of the stopped auto');
  assert.equal(meta()[solo.id].mode, undefined, 'resuming a rule does not restart the auto');

  // 4. A stop on a dormant chat sends no note and does not resume the pane.
  await ok('POST', `/api/sessions/${solo.id}/workflow`, { action: 'start', objective: 'Draft the plan', constraints: [], next: 'Outline' });
  assert.equal(meta()[solo.id].mode, 'ralph');
  fs.writeFileSync(registry, panes().split('\n').filter(line => line !== pane(solo.id)).join('\n'));
  const notesBefore = pastes(solo.id).length;
  await ok('POST', `/api/sessions/${solo.id}/ralph`, { enabled: false });
  entry = meta()[solo.id];
  assert.equal(entry.mode, undefined);
  assert.equal(entry.autoLifecycle, 3);
  assert.equal(entry.autoStopNote.status, 'unobserved', 'note recorded from the previous stop only');
  assert.ok(!panes().includes(solo.id.slice(0, 8)), 'the stop note must not resume a dormant pane');
  assert.equal(pastes(solo.id).length, notesBefore, 'nothing pasted into a dormant pane');
  assert.equal((await findRule()).enabled, false, 'owner stop disables the owned rule again');

  // 5. A chat born in ralph mode keeps it after stop.
  const born = await ok('POST', '/api/chats', { name: 'Born Ralph', mode: 'ralph' });
  assert.equal(born.reviewerSessionId, null);
  assert.equal(meta()[born.id].mode, 'ralph');
  await ok('POST', `/api/sessions/${born.id}/ralph`, { enabled: false });
  assert.equal(meta()[born.id].mode, 'ralph');
  assert.equal(meta()[born.id].ralph.enabled, false);

  // 6. Attach a reviewer to the solo chat, idempotently; the inbox opens; then detach it.
  fs.appendFileSync(registry, `${pane(solo.id)}\n`);
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
  assert.match(startup(attached.chatPair.reviewerSessionId), /Project inbox CLI/);
  const announcement = pastes(solo.id).find(text => text.startsWith('A Reviewer has been attached'));
  assert.ok(announcement, 'the creator was told about the pair');
  assert.match(announcement, /Project inbox CLI/);
  assert.match(announcement, new RegExp(`--group ${attached.chatPair.groupId}`));
  const group = await ok('GET', `/api/sidecar/${attached.chatPair.groupId}`);
  assert.equal(group.group.durable, true);
  assert.equal((await call('GET', `/api/chats/${solo.id}/inbox`)).status, 200, 'the project inbox opens with the pair');
  assert.equal((await inbox(solo.id, { action: 'read' })).status, 200);
  assert.ok((await ok('GET', '/api/project-inboxes')).projects.some(p => p.sessionId === solo.id));
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
  assert.equal((await call('GET', `/api/chats/${solo.id}/inbox`)).status, 409, 'the inbox closes with the pair');
  assert.equal((await call('DELETE', `/api/chats/${solo.id}/reviewer`)).data.detached, false, 'detach is idempotent');
  assert.equal((await call('POST', `/api/chats/${solo.id}/reviewer`, { reviewPolicy: 'bogus' })).status, 400);

  // 7. Deleting the chat while a reviewer is still priming cancels the attempt and leaves no pair.
  const victim = await ok('POST', '/api/chats', { name: 'Victim' });
  const inflight = call('POST', `/api/chats/${victim.id}/reviewer`, { reviewerAgent: 'claude' });
  const pending = await until(() => meta()[victim.id]?.chatReviewerAttach, 'the pending attempt');
  assert.ok(pending?.reviewerSessionId, 'attempt recorded durably before priming');
  assert.equal((await call('POST', `/api/chats/${victim.id}/reviewer`, {})).status, 409, 'a second attach while one is in flight');
  await ok('POST', `/api/sessions/${victim.id}/delete`, {});
  const result = await inflight;
  assert.ok([409, 503].includes(result.status), JSON.stringify(result.data));
  assert.equal(meta()[victim.id], undefined);
  assert.ok(!meta()[pending.reviewerSessionId] || meta()[pending.reviewerSessionId].chatDetachedAt, 'pending reviewer not left behind');
  assert.ok(!panes().includes(pending.reviewerSessionId.slice(0, 8)), 'pending reviewer harness killed');

  // Start /auto on a fresh solo chat and freeze its next reviewer attach while priming.
  async function autoChatWithFrozenAttach(name) {
    const chat = await ok('POST', '/api/chats', { name });
    await ok('POST', `/api/sessions/${chat.id}/send`, { text: 'Keep going.' });
    const g = (await bridge(chat.id, { action: 'read' })).data.generation;
    assert.equal((await bridge(chat.id, { action: 'start', generation: g, objective: `${name} objective`, constraints: [], next: 'go' })).status, 200);
    assert.equal(meta()[chat.id].mode, 'ralph');
    const attach = call('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    const attempt = await until(() => meta()[chat.id]?.chatReviewerAttach, 'the pending attempt');
    hold(attempt.reviewerSessionId); // the reviewer screen keeps changing: priming parks in its settle wait
    await until(() => panes().includes(attempt.reviewerSessionId.slice(0, 8)), 'the reviewer pane');
    await sleep(350); // past the first settle poll: the attach is parked inside prime
    assert.equal(meta()[chat.id].chatReviewerAttach?.token, attempt.token, 'still pending');
    assert.equal(meta()[chat.id].chatPair, null);
    return { chat, attach, attempt };
  }

  // 8. Stop during a paused attach: the attempt is cancelled and cleaned up by the stop
  //    itself, the mode is restored, and the parked attach never becomes a pair.
  {
    const { chat, attach, attempt } = await autoChatWithFrozenAttach('Stop While Priming');
    const stoppedMid = await bridge(chat.id, { action: 'stop' });
    assert.equal(stoppedMid.status, 200, JSON.stringify(stoppedMid.data));
    entry = meta()[chat.id];
    assert.equal(entry.mode, undefined, 'stop restored the ordinary mode');
    assert.equal(entry.chatReviewerAttach, undefined, 'the stop cleaned the pending record');
    assert.equal(entry.chatPair, null);
    assert.ok(!panes().includes(attempt.reviewerSessionId.slice(0, 8)), 'pending reviewer harness killed by the stop');
    assert.ok(meta()[attempt.reviewerSessionId].chatDetachedAt, 'pending reviewer marked detached');
    assert.equal(meta()[attempt.reviewerSessionId].chatStartup?.status, 'failed');
    assert.equal((await ok('GET', `/api/sidecar/${attempt.groupId}`)).group.status, 'done', 'pending group torn down');
    release(attempt.reviewerSessionId);
    const late = await attach;
    assert.equal(late.status, 409, JSON.stringify(late.data));
    assert.equal(meta()[chat.id].chatPair, null, 'the parked attach never became a pair');
    assert.equal(meta()[chat.id].chatReviewerAttach, undefined);
    assert.ok(!pastes(chat.id).some(text => text.startsWith('A Reviewer has been attached')), 'no announcement for a cancelled attach');
    assert.equal(Object.values(meta()).filter(e => e.chatRole === 'reviewer' && !e.chatDetachedAt).length, 0);
    // The chat is ordinary and solo again: a fresh attach works.
    const fresh = await ok('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    assert.equal(fresh.attached, true);
    assert.notEqual(fresh.chatPair.reviewerSessionId, attempt.reviewerSessionId);
    await ok('DELETE', `/api/chats/${chat.id}/reviewer`);
  }

  // 9. Restart before the attach continues: the durable record survives the crash
  //    and the boot sweep removes the reviewer harness, capability and record.
  {
    const { chat, attach, attempt } = await autoChatWithFrozenAttach('Crash While Priming');
    attach.catch(() => {});
    await stop();
    assert.equal(meta()[chat.id].chatReviewerAttach?.token, attempt.token, 'record survives until cleanup succeeds');
    assert.ok(panes().includes(attempt.reviewerSessionId.slice(0, 8)), 'reviewer pane still present after the crash');
    release(attempt.reviewerSessionId);
    await start();
    assert.equal(meta()[chat.id].chatReviewerAttach, undefined, 'boot sweep clears the pending attempt');
    assert.equal(meta()[chat.id].chatPair, null);
    assert.ok(!panes().includes(attempt.reviewerSessionId.slice(0, 8)), 'boot sweep killed the reviewer harness');
    assert.ok(meta()[attempt.reviewerSessionId].chatDetachedAt);
    assert.ok(!fs.existsSync(path.join(home, '.feather/omp-sessions/.feather-bridge-tokens', createHash('sha256').update(attempt.reviewerSessionId).digest('hex'))), 'reviewer capability revoked');
    assert.equal((await ok('GET', `/api/sidecar/${attempt.groupId}`)).group.status, 'done');
    assert.equal(meta()[chat.id].mode, 'ralph', 'the auto itself was not stopped by the crash');
    await ok('POST', `/api/sessions/${chat.id}/ralph`, { enabled: false });
    assert.equal(meta()[chat.id].mode, undefined);
    assert.equal((await findRule()).ownerSessionId, solo.id, 'chat rule ownership survives a restart');
    assert.equal((await findRule()).enabled, false);
    assert.equal(meta()[solo.id].mode, undefined, 'restored mode survives restart');
  }

  // 10. Stop after commit: the pair is preserved, the announcement still lands.
  //     The announcement is pasted and then observed for up to 2s on a constant
  //     screen; the stop and its note arrive inside that window.
  {
    const chat = await ok('POST', '/api/chats', { name: 'Stop After Commit' });
    await ok('POST', `/api/sessions/${chat.id}/send`, { text: 'Keep going.' });
    const g = (await bridge(chat.id, { action: 'read' })).data.generation;
    assert.equal((await bridge(chat.id, { action: 'start', generation: g, objective: 'commit objective', constraints: [], next: 'go' })).status, 200);
    const attach = call('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    const pair = await until(() => meta()[chat.id]?.chatPair, 'the committed pair');
    assert.equal(meta()[chat.id].chatReviewerAttach, undefined);
    const stopping = bridge(chat.id, { action: 'stop' }); // its stop note queues behind the announcement's observation wait
    await until(() => meta()[chat.id]?.mode === undefined, 'the stop write');
    assert.deepEqual(meta()[chat.id].chatPair, pair, 'a stop keeps the committed pair');
    const done = await attach;
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.attached, true);
    assert.equal(done.data.delivery.creator.submitted, true);
    assert.equal((await stopping).status, 200);
    assert.deepEqual(meta()[chat.id].chatPair, pair);
    assert.ok(panes().includes(pair.reviewerSessionId.slice(0, 8)), 'reviewer harness alive after the stop');
    assert.ok(pastes(chat.id).some(text => text.startsWith('A Reviewer has been attached')));
    assert.ok(pastes(chat.id).some(text => text.startsWith('Ongoing work stopped.')));
    assert.equal((await call('GET', `/api/chats/${chat.id}/inbox`)).status, 200);
    await ok('DELETE', `/api/chats/${chat.id}/reviewer`);
  }

  // 11. Detach while the first reviewer is still priming, then re-attach: the
  //     first attempt is fenced out (never announced) and only the new pair is announced.
  {
    const chat = await ok('POST', '/api/chats', { name: 'Fenced Announcement' });
    const first = call('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    const attempt1 = await until(() => meta()[chat.id]?.chatReviewerAttach, 'the first attempt');
    hold(attempt1.reviewerSessionId);
    await until(() => panes().includes(attempt1.reviewerSessionId.slice(0, 8)), 'the first reviewer pane');
    await sleep(350);
    const detaching = await call('DELETE', `/api/chats/${chat.id}/reviewer`);
    assert.equal(detaching.data.detached, true, JSON.stringify(detaching.data));
    assert.equal(detaching.data.reviewerSessionId, attempt1.reviewerSessionId);
    assert.equal(meta()[chat.id].chatReviewerAttach, undefined, 'the detach cleared the pending record');
    release(attempt1.reviewerSessionId);
    const firstResult = await first;
    assert.equal(firstResult.status, 409, JSON.stringify(firstResult.data));
    assert.equal(meta()[chat.id].chatPair, null);
    assert.ok(!pastes(chat.id).some(text => text.startsWith('A Reviewer has been attached')), 'a detached attempt is never announced');
    assert.ok(!panes().includes(attempt1.reviewerSessionId.slice(0, 8)));
    assert.equal((await ok('GET', `/api/sidecar/${attempt1.groupId}`)).group.status, 'done');
    const second = await ok('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    assert.equal(second.attached, true);
    assert.notEqual(second.chatPair.reviewerSessionId, attempt1.reviewerSessionId);
    const announced = pastes(chat.id).filter(text => text.startsWith('A Reviewer has been attached'));
    assert.equal(announced.length, 1, 'exactly one announcement, for the live pair');
    assert.match(announced[0], new RegExp(`--group ${second.chatPair.groupId}`));
    assert.doesNotMatch(announced[0], new RegExp(attempt1.groupId));
    await ok('DELETE', `/api/chats/${chat.id}/reviewer`);
  }

  // 12. Boot sweep of a record left by a crash with no live process at all.
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
});
