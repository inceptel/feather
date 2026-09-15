import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { applyChatWorkflow, authorizeChatWorkflow, publicChatWorkflow } from '../../lib/chat-workflow.js';

test('a newer human direction clears pending activation and invalidates its old start', () => {
  const pending = { ...authorizeChatWorkflow(undefined), pendingStart: true };
  const next = authorizeChatWorkflow(pending);
  assert.equal(next.pendingStart, false);
  assert.throws(() => applyChatWorkflow(next, { action: 'start', generation: pending.generation, objective: 'Old idea' }, { role: 'creator' }), { status: 409 });
});

const options = { role: 'creator', now: 1_000_000, progressCadenceMs: 60_000 };
const apply = (state, input, extra = {}) => applyChatWorkflow(state, input, { ...options, ...extra });
function started() {
  return apply(authorizeChatWorkflow(undefined, options.now), { action: 'start', generation: 1, objective: 'Build the selected idea', constraints: ['Preserve the other ideas'], next: 'Verify the prototype' }).workflow;
}

test('human instruction authorizes a scoped objective and repeated start is idempotent', () => {
  const state = started();
  assert.equal(state.objective, 'Build the selected idea');
  assert.deepEqual(state.constraints, ['Preserve the other ideas']);
  assert.equal(apply(state, { action: 'start', generation: 1 }).changed, false);
  assert.equal(publicChatWorkflow(state).generation, 1);
  assert.equal('humanAuthorized' in publicChatWorkflow(state), false);
});

test('Stop revokes pending authority, including a fresh read after Stop; new human instruction restores it', () => {
  const stopped = apply(started(), { action: 'stop' }).workflow;
  assert.equal(stopped.enabled, false);
  assert.throws(() => apply(stopped, { action: 'start', generation: 1 }), /control changed/);
  const read = apply(stopped, { action: 'read' }).workflow;
  assert.throws(() => apply(stopped, { action: 'start', generation: read.generation }), /new human instruction/);
  const resumed = authorizeChatWorkflow(JSON.parse(JSON.stringify(stopped)), options.now + 1);
  assert.equal(apply(resumed, { action: 'start', generation: resumed.generation }).workflow.enabled, true);
});

test('human UI start grants authority; reviewer and invalid requests are rejected', () => {
  assert.equal(apply(undefined, { action: 'start', generation: 0, objective: 'Current task' }, { role: 'human' }).workflow.enabled, true);
  assert.throws(() => apply(undefined, { action: 'read' }, { role: 'reviewer' }), /Creator or human/);
  assert.throws(() => apply(started(), { action: 'start' }), /control changed/);
  assert.throws(() => apply(started(), { action: 'start', generation: 1, objective: '' }), /objective/);
  assert.throws(() => apply(started(), { action: 'progress', generation: 1, summary: 'x', phase: 'invented' }), /phase/);
});

test('pending scope selection remains visible until scoped start or Stop clears it', () => {
  const pending = { ...authorizeChatWorkflow(undefined, options.now), pendingStart: true };
  assert.equal(publicChatWorkflow(pending).pendingStart, true);
  assert.equal(publicChatWorkflow(pending).enabled, false);
  assert.equal(apply(pending, { action: 'read' }).workflow.pendingStart, true);
  const active = apply(pending, { action: 'start', generation: pending.generation, objective: 'Selected idea' }).workflow;
  assert.equal(active.pendingStart, false);
  assert.equal(active.enabled, true);
  const stopped = apply(pending, { action: 'stop' }).workflow;
  assert.equal(stopped.pendingStart, false);
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.humanAuthorized, false);
});

test('checkpoints deduplicate retries, bound history, and publish only evidence at cadence', () => {
  const input = { action: 'progress', generation: 1, summary: 'Prototype works', evidence: 'Played one round', next: 'Independent review', publish: true, checkpointId: 'first' };
  const first = apply(started(), input);
  assert.equal(first.publish, true);
  assert.equal(apply(first.workflow, input).changed, false);
  assert.throws(() => apply(first.workflow, { ...input, summary: 'Different result' }), /different evidence/);
  const early = apply(first.workflow, { ...input, checkpointId: 'second', summary: 'Second observation' }, { now: options.now + 1 });
  assert.equal(early.publish, false);
  const due = apply(early.workflow, { ...input, checkpointId: 'third', summary: 'New material finding' }, { now: options.now + 60_000 });
  assert.equal(due.publish, true);
  const heartbeat = apply(due.workflow, { action: 'progress', generation: 1, summary: 'Still investigating', publish: true }, { now: options.now + 120_000 });
  assert.equal(heartbeat.publish, false);
  let state = heartbeat.workflow;
  for (let n = 0; n < 70; n++) state = apply(state, { action: 'progress', generation: 1, summary: `Observation ${n}` }).workflow;
  assert.equal(state.checkpoints.length, 50);
});

test('reporting evidence after Stop does not resurrect work', () => {
  const stopped = apply(started(), { action: 'stop' }).workflow;
  const report = apply(stopped, { action: 'progress', generation: stopped.generation, phase: 'working', summary: 'Recorded interrupted result' }).workflow;
  assert.equal(report.enabled, false);
  assert.equal(report.humanAuthorized, false);
  assert.equal(report.phase, 'stopped');
});

test('a new objective retains its own checkpoint even when its observations match the earlier objective', () => {
  const checkpoint = { action: 'progress', generation: 1, summary: 'Prototype checked', evidence: 'Played locally', next: 'Review the result', phase: 'working' };
  const first = apply(started(), checkpoint).workflow;
  const second = apply(first, { action: 'start', generation: 1, objective: 'Build a different selected idea' }).workflow;
  const report = apply(second, checkpoint);
  assert.equal(report.changed, true);
  assert.equal(report.workflow.checkpoints.length, 2);
  assert.notEqual(report.workflow.checkpoints[0].id, report.workflow.checkpoints[1].id);
  assert.equal(report.workflow.checkpoints[1].objective, 'Build a different selected idea');
});

test('CLI rejects delayed start without observed generation before making a network call', () => {
  const child = spawnSync(process.execPath, ['bin/feather-workflow.mjs', 'start', '{"objective":"test"}'], {
    cwd: new URL('../..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, FEATHER_BRIDGE_URL: 'http://127.0.0.1:1', FEATHER_BRIDGE_TOKEN: 'private-fixture', FEATHER_SESSION_ID: 'creator' },
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /generation observed/);
  assert.doesNotMatch(child.stderr, /private-fixture/);
});
