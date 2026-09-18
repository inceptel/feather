import test from 'node:test';
import assert from 'node:assert/strict';
import { attachReviewer, deliveryEvidence, REVIEWER_DETACH_NOTE } from '../../lib/reviewer-attach.js';

function fixture(overrides = {}) {
  const events = [];
  const attempt = { token: 't1', reviewerSessionId: 'reviewer-1', groupId: 'group-1' };
  const deps = {
    allocate: async a => { events.push(['allocate', a.token]); },
    alive: () => true,
    createGroup: async () => { events.push(['createGroup']); },
    spawn: async () => { events.push(['spawn']); },
    prime: async () => { events.push(['prime']); return { submitted: true, observed: false }; },
    commit: (a, delivery) => { events.push(['commit', delivery]); return true; },
    announce: async () => { events.push(['announce']); return { submitted: true, observed: true }; },
    cleanup: async () => { events.push(['cleanup']); },
    detach: async id => { events.push(['detach', id]); },
    ...overrides,
  };
  return { events, attempt, deps };
}
const names = events => events.map(e => e[0]);

test('delivery evidence distinguishes submission from observation', () => {
  assert.deepEqual(deliveryEvidence({ submitted: true }), { submitted: true, observed: false, cancelled: false, dormant: false });
  assert.deepEqual(deliveryEvidence(null), { submitted: false, observed: false, cancelled: false, dormant: false });
  assert.match(REVIEWER_DETACH_NOTE, /no reviewer to consult/);
});

test('happy path allocates, spawns, primes, commits, then announces', async () => {
  const { events, attempt, deps } = fixture();
  const result = await attachReviewer(attempt, deps);
  assert.deepEqual(names(events), ['allocate', 'createGroup', 'spawn', 'prime', 'commit', 'announce']);
  assert.equal(result.attached, true);
  assert.equal(result.reviewerSessionId, 'reviewer-1');
  assert.deepEqual(result.delivery.reviewer, { submitted: true, observed: false, cancelled: false, dormant: false });
  assert.equal(result.delivery.creator.observed, true);
});

test('allocation conflict propagates before any side effect', async () => {
  const { events, attempt, deps } = fixture({ allocate: async () => { throw Object.assign(new Error('busy'), { status: 409 }); } });
  await assert.rejects(attachReviewer(attempt, deps), { status: 409 });
  assert.deepEqual(events, []);
});

test('chat moving on after spawn cleans up without committing', async () => {
  let spawned = false;
  const { events, attempt, deps } = fixture({ alive: () => !spawned, spawn: async () => { spawned = true; events.push(['spawn']); } });
  await assert.rejects(attachReviewer(attempt, deps), { status: 409 });
  assert.deepEqual(names(events), ['allocate', 'createGroup', 'spawn', 'cleanup']);
});

test('cancelled priming that never submitted is a 409, not a ready reviewer', async () => {
  const { events, attempt, deps } = fixture({ prime: async () => ({ submitted: false, cancelled: true }) });
  await assert.rejects(attachReviewer(attempt, deps), { status: 409 });
  assert.ok(!names(events).includes('commit'));
  assert.equal(names(events).at(-1), 'cleanup');
});

test('unverified priming is a 503 and the reviewer is torn down', async () => {
  const { events, attempt, deps } = fixture({ prime: async () => { events.push(['prime']); return { submitted: false, observed: false }; } });
  await assert.rejects(attachReviewer(attempt, deps), { status: 503, message: /priming not verified/ });
  assert.deepEqual(names(events), ['allocate', 'createGroup', 'spawn', 'prime', 'cleanup']);
});

test('spawn failure rethrows the original error after cleanup', async () => {
  const { events, attempt, deps } = fixture({ spawn: async () => { throw new Error('harness missing'); } });
  await assert.rejects(attachReviewer(attempt, deps), { message: 'harness missing' });
  assert.deepEqual(names(events), ['allocate', 'createGroup', 'cleanup']);
});

test('a refused commit (chat stopped or deleted during priming) cleans up', async () => {
  const { events, attempt, deps } = fixture({ commit: () => false });
  await assert.rejects(attachReviewer(attempt, deps), { status: 409 });
  assert.deepEqual(names(events), ['allocate', 'createGroup', 'spawn', 'prime', 'cleanup']);
  assert.ok(!names(events).includes('announce'));
});

test('an announcement that could not be submitted detaches the committed reviewer', async () => {
  for (const announce of [async () => ({ submitted: false, dormant: true }), async () => { throw new Error('pane gone'); }]) {
    const { events, attempt, deps } = fixture({ announce });
    await assert.rejects(attachReviewer(attempt, deps), { status: 503, message: /detached again/ });
    assert.deepEqual(names(events).slice(-2), ['commit', 'detach']);
    assert.equal(events.at(-1)[1], 'reviewer-1');
    assert.ok(!names(events).includes('cleanup'), 'a committed pair is detached, not cleaned up as pending');
  }
});
