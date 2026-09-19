import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { projectInboxWakeIds } from '../../lib/project-inbox-wakes.js';
import { mayReenableRalph } from '../../lib/autopilot.js';
import { applyChatWorkflow, authorizeChatWorkflow } from '../../lib/chat-workflow.js';

// Run the server's actual wake, boundary, and Stop paths without a server or
// harness. Timers are recorded but never launch a turn.
const server = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const callbacks = server.slice(server.indexOf('const ralphCallbackTimers = new Map();'), server.indexOf('// ── SSE ─'));
function fixture() {
  let meta = { a: { chatProjectId: 'p', chatRole: 'creator', mode: 'ralph', ralph: { enabled: true, status: 'working' } } };
  const project = { projectId: 'p', config: { objective: 'Build game' }, tasks: [{ id: 'board', owner: null, status: 'queued', dependsOn: [] }] };
  let sequence = 0;
  const timers = new Set();
  const context = vm.createContext({
    RALPH_MODE: 'ralph', RALPH_CALLBACK_DELAY_MS: 100,
    readMeta: () => meta, updateMeta: mutator => { meta = mutator(meta); },
    isRalphSession: id => meta[id]?.mode === 'ralph', mayReenableRalph, applyChatWorkflow, authorizeChatWorkflow,
    projectInboxWakeIds, PROJECT_INBOX: { read: () => project },
    randomUUID: () => `token-${++sequence}`,
    setTimeout: () => { const timer = ++sequence; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  vm.runInContext(callbacks, context);
  return { context, project, timers, state: () => meta.a.ralph, meta: () => meta };
}

test('human task added during setup survives the initial blocked boundary once', () => {
  const f = fixture();
  f.context.wakeProjectInbox('p', { human: true, action: 'add' });
  assert.equal(f.state().status, 'working');
  assert.equal(f.state().pendingInboxHumanWake, 'add');
  assert.equal(f.timers.size, 0);
  f.context.scheduleRalphCallback('a', { key: 'setup', blocked: 'Awaiting user objective' });
  assert.equal(f.state().enabled, true);
  assert.equal(f.state().status, 'scheduled');
  assert.equal(f.state().pendingInboxHumanWake, null);
  assert.equal(f.timers.size, 1);
  f.context.scheduleRalphCallback('a', { key: 'retry', blocked: 'Still blocked' });
  assert.equal(f.state().enabled, false);
  assert.equal(f.state().status, 'blocked');
  assert.equal(f.timers.size, 0);
});

test('Stop clears a deferred human event and prevents stale boundaries waking work', () => {
  const f = fixture();
  f.context.wakeProjectInbox('p', { human: true, action: 'add' });
  f.context.stopRalphSession('a');
  assert.equal(f.state().pendingInboxHumanWake, null);
  f.context.scheduleRalphCallback('a', { key: 'setup', blocked: 'Awaiting user objective' });
  f.context.wakeProjectInbox('p', { human: true, action: 'add' });
  assert.equal(f.state().status, 'stopped');
  assert.equal(f.state().enabled, false);
  assert.equal(f.timers.size, 0);
});

test('deferred human event cannot reopen an owned task blocker', () => {
  const f = fixture();
  f.context.wakeProjectInbox('p', { human: true, action: 'add' });
  Object.assign(f.project.tasks[0], { owner: 'a', status: 'blocked' });
  f.project.tasks.push({ id: 'another', owner: null, status: 'queued', dependsOn: [] });
  f.context.scheduleRalphCallback('a', { key: 'task', blocked: 'Need credentials' });
  assert.equal(f.state().status, 'blocked');
  assert.equal(f.state().pendingInboxHumanWake, null);
  assert.equal(f.timers.size, 0);
});

test('deferred wake is scoped to the creator reaching its boundary', () => {
  const f = fixture();
  f.meta().b = { chatProjectId: 'p', chatRole: 'creator', mode: 'ralph', ralph: { enabled: false, status: 'blocked' } };
  f.context.wakeProjectInbox('p', { human: true, action: 'add', sessionId: 'a' });
  f.context.scheduleRalphCallback('a', { key: 'setup', blocked: 'Awaiting user objective' });
  assert.equal(f.state().status, 'scheduled');
  assert.equal(f.meta().b.ralph.status, 'blocked');
  assert.equal(f.meta().b.ralph.enabled, false);
});

test('waiting boundary recovers both deferred human and ordinary agent additions', () => {
  for (const human of [true, false]) {
    const f = fixture();
    f.context.wakeProjectInbox('p', { human, action: 'add' });
    f.context.scheduleRalphCallback('a', { key: 'waiting', waiting: 'Inbox empty' });
    assert.equal(f.state().status, 'scheduled');
    assert.ok(!f.state().pendingInboxHumanWake);
    assert.equal(f.timers.size, 1);
  }
});

test('deferred human unblock can resume an agreeing task at a waiting boundary', () => {
  const f = fixture();
  Object.assign(f.project.tasks[0], { owner: 'a', status: 'agreeing' });
  f.context.wakeProjectInbox('p', { human: true, action: 'unblock' });
  assert.equal(f.state().pendingInboxHumanWake, 'unblock');
  f.context.scheduleRalphCallback('a', { key: 'waiting', waiting: 'Waiting on blocker' });
  assert.equal(f.state().status, 'scheduled');
  assert.equal(f.state().pendingInboxHumanWake, null);
  assert.equal(f.timers.size, 1);
});

test('agent additions cannot override a blocked boundary', () => {
  const f = fixture();
  f.context.wakeProjectInbox('p', { action: 'add' });
  f.context.scheduleRalphCallback('a', { key: 'setup', blocked: 'Awaiting user objective' });
  assert.equal(f.state().enabled, false);
  assert.equal(f.state().status, 'blocked');
  assert.equal(f.timers.size, 0);
});

test('human work added during a turn survives its complete boundary once', () => {
  const f = fixture();
  f.context.wakeProjectInbox('p', { human: true, action: 'add' });
  f.context.scheduleRalphCallback('a', { key: 'old-objective', complete: 'Assignment finished' });
  assert.equal(f.state().enabled, true);
  assert.equal(f.state().status, 'scheduled');
  assert.equal(f.state().pendingInboxHumanWake, null);
  assert.equal(f.timers.size, 1);
  f.context.scheduleRalphCallback('a', { key: 'new-objective', complete: 'Assignment finished' });
  assert.equal(f.state().enabled, false);
  assert.equal(f.state().status, 'complete');
  assert.equal(f.timers.size, 0);
});

test('deferred human unblock survives a stale blocked boundary only while task is agreeing', () => {
  for (const blockedAgain of [false, true]) {
    const f = fixture();
    Object.assign(f.project.tasks[0], { owner: 'a', status: 'agreeing' });
    f.context.wakeProjectInbox('p', { human: true, action: 'unblock' });
    assert.equal(f.state().pendingInboxHumanWake, 'unblock');
    if (blockedAgain) f.project.tasks[0].status = 'blocked';
    f.context.scheduleRalphCallback('a', { key: 'old-blocker', blocked: 'Waiting on blocker' });
    assert.equal(f.state().pendingInboxHumanWake, null);
    assert.equal(f.state().enabled, !blockedAgain);
    assert.equal(f.state().status, blockedAgain ? 'blocked' : 'scheduled');
    assert.equal(f.timers.size, blockedAgain ? 0 : 1);
  }
});
