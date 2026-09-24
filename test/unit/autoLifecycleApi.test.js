import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { freePort } from './freePort.js';
import { stopChild } from './stopChild.js';

// Solo-by-default chats, /auto start and stop, chat-owned schedules, and
// reviewer attach/detach, all against the real server with a fake tmux.
test('solo chats start, work, stop cleanly, own schedules, and gain or lose a reviewer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-auto-api-'));
  const home = path.join(root, 'home'), state = path.join(root, 'state'), bin = path.join(root, 'bin');
  for (const dir of [home, state, bin]) fs.mkdirSync(dir);
  const registry = path.join(root, 'panes');
  fs.writeFileSync(registry, '');
  // The fake tmux keeps a pane registry, dumps its environment on new-session
  // and logs every paste. Like a real terminal, a pane's screen changes when
  // text is pasted or keys are sent, so the server confirms delivery at once
  // instead of waiting out its "no screen change" timeouts. While
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
kill-session) if [ -e "$TMUX_REG.nokill.$target" ]; then exit 1; fi; grep -vxF "$target" "$TMUX_REG" > "$TMUX_REG.n"; mv "$TMUX_REG.n" "$TMUX_REG" ;;
capture-pane) if [ -e "$TMUX_REG.hold.$target" ]; then date +%s%N; else echo ready; cat "$TMUX_REG.screen.$target" 2>/dev/null; fi ;;
send-keys) printf 'k\\n' >> "$TMUX_REG.screen.$target" ;;
load-buffer) cat "$4" > "$TMUX_REG.buf.$3" 2>/dev/null || true ;;
paste-buffer) name=''; prev=''; for a in "$@"; do if [ "$prev" = '-b' ]; then name="$a"; fi; prev="$a"; done
  { printf '%s\\t' "$target"; base64 -w0 < "$TMUX_REG.buf.$name"; printf '\\n'; } >> "$TMUX_REG.pastes"; printf 'p\\n' >> "$TMUX_REG.screen.$target" ;;
esac
exit 0
`, { mode: 0o755 });
  const barriers = path.join(root, 'barriers');
  fs.mkdirSync(barriers);
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
        FEATHER_ROOM_PULSES: '0', FEATHER_SCHEDULER: '0', FEATHER_TMUX_READY_TIMEOUT_MS: '6000', FEATHER_TMUX_SETTLE_MIN_MS: '50', FEATHER_TEST_BARRIER_DIR: barriers,
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
  async function stop() { await stopChild(child); }
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
  const noKill = id => fs.writeFileSync(`${registry}.nokill.${pane(id)}`, '');
  const allowKill = id => fs.rmSync(`${registry}.nokill.${pane(id)}`, { force: true });
  // Server-side pause points (FEATHER_TEST_BARRIER_DIR): arm before the code
  // path runs, wait for arrival, act, then open the barrier.
  const barrier = (name, id) => ({
    arm: () => fs.writeFileSync(path.join(barriers, `${name}.${id}`), ''),
    arrived: () => fs.existsSync(path.join(barriers, `${name}.${id}.waiting`)),
    open: () => { fs.rmSync(path.join(barriers, `${name}.${id}`), { force: true }); fs.rmSync(path.join(barriers, `${name}.${id}.waiting`), { force: true }); },
  });
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
  // An ordinary chat that never entered /auto leaves no autonomous history,
  // whether it is interrupted or told to stop.
  await ok('POST', `/api/sessions/${solo.id}/interrupt`, {});
  assert.equal((await bridge(solo.id, { action: 'stop' })).status, 200);
  assert.equal((await ok('GET', '/api/sessions')).sessions.find(s => s.id === solo.id).auto, undefined, 'no history marker for a chat that was never autonomous');
  assert.equal(meta()[solo.id].autoStoppedAt, undefined);

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
  assert.equal(meta()[solo.id].autoLifecycle, 3);
  assert.ok(pastes(solo.id).some(text => text.startsWith('Ongoing work stopped.')), 'the stop note reached the creator pane');
  const stoppedRow = (await ok('GET', '/api/sessions')).sessions.find(s => s.id === solo.id);
  assert.equal(stoppedRow.mode, undefined);
  assert.equal(stoppedRow.auto?.lifecycle, 3, 'a stopped auto keeps a public history marker');
  assert.ok(stoppedRow.auto.stoppedAt);
  assert.equal((await bridge(solo.id, { action: 'stop' })).status, 200, 'a second stop is a no-op');
  assert.equal((await ok('GET', '/api/sessions')).sessions.find(s => s.id === solo.id).auto.stoppedAt, stoppedRow.auto.stoppedAt, 'a no-op stop does not rewrite history');
  const refused = await bridge(solo.id, { action: 'start', generation: gen + 1, objective: 'Draft the plan' });
  assert.equal(refused.status, 409, 'no restart without a new human instruction');
  assert.match(refused.data.error, /human instruction/);
  await ok('POST', `/api/sessions/${solo.id}/send`, { text: 'Go on.' });
  const read2 = await bridge(solo.id, { action: 'read' });
  const restarted = await bridge(solo.id, { action: 'start', generation: read2.data.generation, objective: 'Draft the plan', constraints: [], next: 'Outline' });
  assert.equal(restarted.status, 200, JSON.stringify(restarted.data));
  assert.equal(meta()[solo.id].mode, 'ralph');
  assert.equal(meta()[solo.id].autoModeBefore, null);
  assert.equal((await ok('GET', '/api/sessions')).sessions.find(s => s.id === solo.id).auto, undefined, 'a restart returns the chat to active: history cleared');

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
  assert.equal(entry.autoLifecycle, 5);
  assert.equal(entry.autoStopNote?.status, 'delivered', JSON.stringify(entry.autoStopNote));
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
  assert.equal(entry.autoLifecycle, 6);
  assert.equal(entry.autoStopNote, undefined, 'no note for a dormant chat, and the restart cleared the previous one');
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

  // 8b. Stop during a paused attach whose cleanup fails: the attempt is no
  //     longer pending (the stop's own write moved it to a cleanup tombstone),
  //     but the reviewer's resources stay owned, on both sides, until they are
  //     really gone; the next attach retries that cleanup itself.
  const tombstones = id => meta()[id]?.chatReviewerCleanup || [];
  {
    const { chat, attach, attempt } = await autoChatWithFrozenAttach('Stop With Failing Cleanup');
    noKill(attempt.reviewerSessionId);
    assert.equal((await bridge(chat.id, { action: 'stop' })).status, 200);
    assert.equal(meta()[chat.id].mode, undefined);
    assert.equal(meta()[chat.id].chatReviewerAttach, undefined, 'the stop write ended the attempt');
    assert.deepEqual(tombstones(chat.id).map(item => item.reviewerSessionId), [attempt.reviewerSessionId], 'cleanup ownership kept while the harness is still alive');
    assert.ok(panes().includes(attempt.reviewerSessionId.slice(0, 8)), 'the harness the kill could not remove');
    assert.ok(meta()[attempt.reviewerSessionId].chatDetachedAt);
    assert.equal(meta()[attempt.reviewerSessionId].chatCleanupPending?.creatorSessionId, chat.id, 'the reviewer entry mirrors the pending cleanup');
    assert.match(logs, /not fully cleaned; record kept/);
    release(attempt.reviewerSessionId);
    assert.equal((await attach).status, 409);
    assert.equal(tombstones(chat.id).length, 1, 'the attempt\'s own cleanup also failed to remove the harness: still owned');
    const blocked = await call('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    assert.equal(blocked.status, 409, 'no new reviewer while the old one is not cleaned up');
    assert.match(blocked.data.error, /still being cleaned up/);
    allowKill(attempt.reviewerSessionId);
    const fresh = await ok('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    assert.equal(fresh.attached, true, 'the attach retried the cleanup and went ahead once it succeeded');
    assert.equal(tombstones(chat.id).length, 0);
    assert.equal(meta()[attempt.reviewerSessionId].chatCleanupPending, undefined);
    assert.ok(!panes().includes(attempt.reviewerSessionId.slice(0, 8)));
    assert.equal((await ok('GET', `/api/sidecar/${attempt.groupId}`)).group.status, 'done');
    await ok('DELETE', `/api/chats/${chat.id}/reviewer`);
  }

  // 8c. A failed stop cleanup, then the creator is deleted, then a restart: the
  //     reviewer's own entry keeps the cleanup owned, and the boot sweep finishes it.
  {
    const { chat, attach, attempt } = await autoChatWithFrozenAttach('Delete After Failed Cleanup');
    noKill(attempt.reviewerSessionId);
    assert.equal((await bridge(chat.id, { action: 'stop' })).status, 200);
    release(attempt.reviewerSessionId);
    assert.equal((await attach).status, 409);
    assert.equal(tombstones(chat.id).length, 1);
    await ok('POST', `/api/sessions/${chat.id}/delete`);
    assert.equal(meta()[chat.id], undefined);
    assert.ok(panes().includes(attempt.reviewerSessionId.slice(0, 8)), 'still not killable');
    assert.equal(meta()[attempt.reviewerSessionId].chatCleanupPending?.creatorSessionId, chat.id, 'ownership survives the creator');
    allowKill(attempt.reviewerSessionId);
    await stop();
    await start();
    assert.ok(!panes().includes(attempt.reviewerSessionId.slice(0, 8)), 'boot sweep finished the orphaned cleanup');
    assert.equal(meta()[attempt.reviewerSessionId].chatCleanupPending, undefined);
    assert.equal((await ok('GET', `/api/sidecar/${attempt.groupId}`)).group.status, 'done');
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

  // Start /auto on a fresh chat and run an attach up to a named server barrier.
  async function autoChatAtBarrier(name, point) {
    const chat = await ok('POST', '/api/chats', { name });
    await ok('POST', `/api/sessions/${chat.id}/send`, { text: 'Keep going.' });
    const g = (await bridge(chat.id, { action: 'read' })).data.generation;
    assert.equal((await bridge(chat.id, { action: 'start', generation: g, objective: `${name} objective`, constraints: [], next: 'go' })).status, 200);
    const gate = barrier(point, chat.id);
    gate.arm();
    const attach = call('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    const attempt = await until(() => meta()[chat.id]?.chatReviewerAttach, 'the pending attempt');
    await until(gate.arrived, `the attach to reach ${point}`);
    return { chat, attach, attempt, gate };
  }
  const creatorPastes = id => pastes(id).map(text => text.split('\n')[0].slice(0, 40));
  const lastPastes = (id, ...prefixes) => { const tail = creatorPastes(id).slice(-prefixes.length); assert.deepEqual(tail.map((line, n) => line.startsWith(prefixes[n]) ? prefixes[n] : line), prefixes, JSON.stringify(creatorPastes(id))); };

  // 10a. Stop after priming, before commit: no pair is ever committed, the attempt
  //      is cleaned up, the stop note is the last thing the creator sees.
  {
    const { chat, attach, attempt, gate } = await autoChatAtBarrier('Stop Before Commit', 'attach-before-commit');
    assert.ok(pastes(attempt.reviewerSessionId).length, 'the reviewer was primed');
    assert.equal((await bridge(chat.id, { action: 'stop' })).status, 200);
    assert.equal(meta()[chat.id].mode, undefined);
    assert.equal(meta()[chat.id].chatReviewerAttach, undefined, 'stop cleaned the primed-but-uncommitted attempt');
    gate.open();
    const late = await attach;
    assert.equal(late.status, 409, JSON.stringify(late.data));
    assert.equal(meta()[chat.id].chatPair, null, 'never committed');
    assert.ok(!panes().includes(attempt.reviewerSessionId.slice(0, 8)));
    assert.ok(!pastes(chat.id).some(text => text.startsWith('A Reviewer has been attached')));
    lastPastes(chat.id, 'Ongoing work stopped.');
  }

  // 10b. Stop after commit, before the announcement is submitted: the lifecycle
  //      fence cancels the announcement (its instructions were captured while the
  //      chat was autonomous), the unannounced reviewer is detached again, and only
  //      the stop note lands.
  {
    const { chat, attach, attempt, gate } = await autoChatAtBarrier('Stop Before Announce', 'attach-before-announce');
    assert.equal(meta()[chat.id].chatPair?.reviewerSessionId, attempt.reviewerSessionId, 'committed');
    assert.equal((await bridge(chat.id, { action: 'stop' })).status, 200);
    assert.equal(meta()[chat.id].mode, undefined);
    assert.equal(meta()[chat.id].chatPair?.reviewerSessionId, attempt.reviewerSessionId, 'a stop by itself keeps the committed pair');
    gate.open();
    const late = await attach;
    assert.equal(late.status, 503, JSON.stringify(late.data));
    assert.match(late.data.error, /could not be announced; it was detached again/);
    assert.equal(meta()[chat.id].chatPair, null, 'an unannounced pair is unwound');
    assert.ok(!panes().includes(attempt.reviewerSessionId.slice(0, 8)));
    assert.ok(meta()[attempt.reviewerSessionId].chatDetachedAt);
    assert.ok(!pastes(chat.id).some(text => text.startsWith('A Reviewer has been attached')), 'autonomous-era instructions never land after Stop');
    lastPastes(chat.id, 'Ongoing work stopped.');
    assert.equal(meta()[chat.id].autoStopNote?.status, 'delivered', 'the stop note was submitted despite the later detach bump');
  }

  // 10b'. The unannounced pair's detach fails to kill the reviewer: the logical
  //       pair is gone but cleanup stays owned; a later attach retries it.
  {
    const { chat, attach, attempt, gate } = await autoChatAtBarrier('Failed Unannounced Detach', 'attach-before-announce');
    noKill(attempt.reviewerSessionId);
    assert.equal((await bridge(chat.id, { action: 'stop' })).status, 200);
    gate.open();
    const late = await attach;
    assert.equal(late.status, 503, JSON.stringify(late.data));
    assert.equal(meta()[chat.id].chatPair, null, 'logically detached');
    assert.deepEqual(tombstones(chat.id).map(item => item.reviewerSessionId), [attempt.reviewerSessionId], 'physical cleanup still owned');
    assert.ok(panes().includes(attempt.reviewerSessionId.slice(0, 8)));
    const blocked = await call('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
    assert.match(blocked.data.error, /still being cleaned up/);
    allowKill(attempt.reviewerSessionId);
    const fresh = await ok('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    assert.equal(fresh.attached, true);
    assert.equal(tombstones(chat.id).length, 0);
    assert.ok(!panes().includes(attempt.reviewerSessionId.slice(0, 8)));
    await ok('DELETE', `/api/chats/${chat.id}/reviewer`);
  }

  // 10c. Stop while the announcement sits at the paste boundary (after its
  //      capture, before paste + Enter): the re-check cancels it.
  {
    const { chat, attach, attempt, gate } = await autoChatAtBarrier('Stop At Paste', 'send-before-paste');
    assert.equal(meta()[chat.id].chatPair?.reviewerSessionId, attempt.reviewerSessionId, 'committed and announcing');
    const stopping = bridge(chat.id, { action: 'stop' }); // its note queues behind the parked announcement
    await until(() => meta()[chat.id]?.mode === undefined, 'the stop write');
    gate.open();
    const late = await attach;
    assert.equal(late.status, 503, JSON.stringify(late.data));
    assert.equal((await stopping).status, 200);
    assert.equal(meta()[chat.id].chatPair, null);
    assert.ok(!pastes(chat.id).some(text => text.startsWith('A Reviewer has been attached')), 'nothing pasted after the fence failed');
    lastPastes(chat.id, 'Ongoing work stopped.');
  }

  // 10d. Stop after the announcement was submitted (during its observation wait):
  //      the pair is preserved and both messages are on the creator pane in order.
  {
    const chat = await ok('POST', '/api/chats', { name: 'Stop After Announce' });
    await ok('POST', `/api/sessions/${chat.id}/send`, { text: 'Keep going.' });
    const g = (await bridge(chat.id, { action: 'read' })).data.generation;
    assert.equal((await bridge(chat.id, { action: 'start', generation: g, objective: 'commit objective', constraints: [], next: 'go' })).status, 200);
    const attach = call('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    const pair = await until(() => meta()[chat.id]?.chatPair, 'the committed pair');
    await until(() => pastes(chat.id).some(text => text.startsWith('A Reviewer has been attached')), 'the announcement paste');
    const stopping = bridge(chat.id, { action: 'stop' }); // the announcement is still being observed (2s)
    await until(() => meta()[chat.id]?.mode === undefined, 'the stop write');
    assert.deepEqual(meta()[chat.id].chatPair, pair, 'a stop keeps the committed pair');
    const done = await attach;
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.delivery.creator.submitted, true);
    assert.equal((await stopping).status, 200);
    assert.deepEqual(meta()[chat.id].chatPair, pair);
    assert.ok(panes().includes(pair.reviewerSessionId.slice(0, 8)), 'reviewer harness alive after the stop');
    lastPastes(chat.id, 'A Reviewer has been attached', 'Ongoing work stopped.');
    assert.equal((await call('GET', `/api/chats/${chat.id}/inbox`)).status, 200);
    await ok('DELETE', `/api/chats/${chat.id}/reviewer`);
  }

  // 11a. Detach while the first reviewer is still priming, then re-attach: the
  //      first attempt is never announced and only the new pair is.
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

  // 11b. Detach a committed pair before its announcement is submitted, then attach
  //      a new reviewer: the old announcement is fenced by identity, the detach note
  //      precedes the one announcement, which names only the new group. (A new pair
  //      cannot form while the old attempt is still in flight: the second attach is
  //      refused with 409 until the first has unwound.)
  {
    const chat = await ok('POST', '/api/chats', { name: 'Detach Before Announce' });
    const gate = barrier('attach-before-announce', chat.id);
    gate.arm();
    const first = call('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    const pair1 = await until(() => meta()[chat.id]?.chatPair, 'the first committed pair');
    await until(gate.arrived, 'the announcement barrier');
    const detaching = await call('DELETE', `/api/chats/${chat.id}/reviewer`);
    assert.equal(detaching.data.detached, true);
    assert.equal(meta()[chat.id].chatPair, null);
    assert.equal((await call('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' })).status, 409, 'no new pair while the old attempt is in flight');
    gate.open();
    const firstResult = await first;
    assert.equal(firstResult.status, 503, JSON.stringify(firstResult.data));
    assert.ok(!pastes(chat.id).some(text => text.startsWith('A Reviewer has been attached')), 'a detached pair is never announced');
    assert.ok(!panes().includes(pair1.reviewerSessionId.slice(0, 8)));
    const second = await ok('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    assert.equal(second.attached, true);
    assert.notEqual(second.chatPair.reviewerSessionId, pair1.reviewerSessionId);
    const announced = pastes(chat.id).filter(text => text.startsWith('A Reviewer has been attached'));
    assert.equal(announced.length, 1, 'exactly one announcement, for the live pair');
    assert.match(announced[0], new RegExp(`--group ${second.chatPair.groupId}`));
    assert.doesNotMatch(announced[0], new RegExp(pair1.groupId));
    lastPastes(chat.id, 'Reviewer detached.', 'A Reviewer has been attached');
    await ok('DELETE', `/api/chats/${chat.id}/reviewer`);
  }

  // A solo /auto chat whose stop note is parked at the paste boundary, so a
  // later control action can race it.
  async function autoChatWithParkedStopNote(name) {
    const chat = await ok('POST', '/api/chats', { name });
    await ok('POST', `/api/sessions/${chat.id}/send`, { text: 'Keep going.' });
    const g = (await bridge(chat.id, { action: 'read' })).data.generation;
    assert.equal((await bridge(chat.id, { action: 'start', generation: g, objective: `${name} objective`, constraints: [], next: 'go' })).status, 200);
    const gate = barrier('send-before-paste', chat.id);
    gate.arm();
    const stopping = bridge(chat.id, { action: 'stop' });
    await until(gate.arrived, 'the stop note to reach the paste boundary');
    const stopId = meta()[chat.id].autoStopId;
    assert.ok(stopId, 'a stop identity was written');
    assert.equal(meta()[chat.id].mode, undefined);
    return { chat, gate, stopping, stopId };
  }
  const stopNotes = id => pastes(id).filter(text => text.startsWith('Ongoing work stopped.')).length;
  const humanStart = (id, name) => call('POST', `/api/sessions/${id}/workflow`, { action: 'start', objective: `${name} again`, constraints: [], next: 'go' });

  // 13a. Stop, start again, stop again while the first note is still queued: the
  //      first note is fenced by its stop identity and only the second lands.
  {
    const { chat, gate, stopping, stopId } = await autoChatWithParkedStopNote('Stop Start Stop');
    const starting = humanStart(chat.id, 'Stop Start Stop'); // its instructions queue behind the parked note
    await until(() => meta()[chat.id]?.mode === 'ralph', 'the human start');
    assert.equal(meta()[chat.id].autoStopId, undefined, 'a start clears the stop identity');
    const stopping2 = bridge(chat.id, { action: 'stop' });
    await until(() => meta()[chat.id]?.mode === undefined && meta()[chat.id]?.autoStopId, 'the second stop');
    assert.notEqual(meta()[chat.id].autoStopId, stopId, 'the second stop has its own identity');
    gate.open();
    const first = await stopping;
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(stopNotes(chat.id), 0, 'the first note never pasted');
    assert.equal((await starting).status, 200);
    const second = await stopping2;
    assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(stopNotes(chat.id), 1, 'exactly one stop note');
    lastPastes(chat.id, 'Ongoing work stopped.');
    assert.equal(meta()[chat.id].autoStopNote?.status, 'delivered', 'the receipt belongs to the second stop');
  }

  // 13b. Stop, start again, interrupt while the first note is still queued: the
  //      interrupt stops without a note and the queued note is dropped too.
  {
    const { chat, gate, stopping } = await autoChatWithParkedStopNote('Stop Start Interrupt');
    const starting = humanStart(chat.id, 'Stop Start Interrupt');
    await until(() => meta()[chat.id]?.mode === 'ralph', 'the human start');
    await ok('POST', `/api/sessions/${chat.id}/interrupt`);
    assert.equal(meta()[chat.id].mode, undefined, 'interrupt stopped the restarted work');
    gate.open();
    assert.equal((await stopping).status, 200);
    await starting;
    assert.equal(stopNotes(chat.id), 0, 'no stale stop note after an interrupt');
    assert.equal(meta()[chat.id].autoStopNote, undefined, 'no receipt for a cancelled note');
    assert.ok(meta()[chat.id].autoStoppedAt, 'the history marker stays');
  }

  // 13c. A reviewer-only detach while the note is queued keeps the stop identity:
  //      the note still lands, and the detach note follows it.
  {
    const name = 'Stop Then Detach';
    const chat = await ok('POST', '/api/chats', { name });
    await ok('POST', `/api/sessions/${chat.id}/send`, { text: 'Keep going.' });
    const g = (await bridge(chat.id, { action: 'read' })).data.generation;
    assert.equal((await bridge(chat.id, { action: 'start', generation: g, objective: `${name} objective`, constraints: [], next: 'go' })).status, 200);
    const attached = await ok('POST', `/api/chats/${chat.id}/reviewer`, { reviewerAgent: 'claude' });
    assert.equal(attached.attached, true);
    const gate = barrier('send-before-paste', chat.id);
    gate.arm();
    const stopping = bridge(chat.id, { action: 'stop' });
    await until(gate.arrived, 'the stop note to reach the paste boundary');
    const stopId = meta()[chat.id].autoStopId;
    const detaching = call('DELETE', `/api/chats/${chat.id}/reviewer`);
    await until(() => meta()[chat.id]?.chatPair === null, 'the detach write');
    assert.equal(meta()[chat.id].autoStopId, stopId, 'a detach keeps the stop identity');
    gate.open();
    assert.equal((await stopping).status, 200);
    assert.equal((await detaching).status, 200);
    lastPastes(chat.id, 'Ongoing work stopped.', 'Reviewer detached.');
    assert.equal(meta()[chat.id].autoStopNote?.status, 'delivered');
    assert.equal(tombstones(chat.id).length, 0);
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
