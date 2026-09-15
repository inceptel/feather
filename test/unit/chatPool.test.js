import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatPool } from '../../lib/chat-pool.js';

function fixture(t, options = {}) {
  let next = 0;
  const retired = [], claimed = [];
  const pool = createChatPool({ capacity: 1, create: async () => ({ id: `pair-${++next}` }),
    healthy: () => true, claim: entry => { claimed.push(entry.id); return entry; },
    retire: (entry, reason) => retired.push({ entry, reason }), ...options });
  t.after(() => pool.close());
  return { pool, retired, claimed };
}

test('claims reserve distinct identities and refill never reuses claimed conversations', async t => {
  const { pool, claimed } = fixture(t, { capacity: 2 });
  await Promise.all([pool.refill(), pool.refill()]);
  const first = pool.acquire(), second = pool.acquire();
  assert.notEqual(first.id, second.id);
  assert.equal(pool.acquire(), null);
  await pool.refill();
  assert.ok(!claimed.includes(pool.snapshot().ready[0].id));
});

test('dead restored pairs retire and empty pool falls back while replenishing', async t => {
  const { pool, retired } = fixture(t, { initialEntries: () => [{ id: 'dead' }], healthy: entry => entry.id !== 'dead' });
  assert.equal(pool.acquire(), null);
  assert.equal(retired[0].entry.id, 'dead');
  await pool.refill();
  assert.ok(pool.acquire());
});

test('failed refill backs off instead of spinning and zero capacity never spawns', async t => {
  let calls = 0;
  const { pool } = fixture(t, { create: async () => { calls++; throw new Error('engine unavailable'); } });
  await pool.refill();
  await pool.refill();
  assert.equal(calls, 1);
  assert.ok(pool.snapshot().retryAt > Date.now());
  const disabled = fixture(t, { capacity: 0, create: async () => { throw new Error('must not spawn'); } }).pool;
  await disabled.refill();
  assert.equal(disabled.acquire(), null);
});

test('closing during creation retires the unclaimed result', async t => {
  let resolve;
  const { pool, retired } = fixture(t, { create: () => new Promise(done => { resolve = done; }) });
  const pending = pool.refill();
  await Promise.resolve();
  pool.close();
  resolve({ id: 'late' });
  await pending;
  assert.equal(pool.acquire(), null);
  assert.equal(retired[0].entry.id, 'late');
});

test('repeated engine failure opens a circuit until explicit recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0, available = false;
  const { pool } = fixture(t, { backoffMs: 10, maxBackoffMs: 20, maxFailures: 3,
    create: async () => { calls++; if (!available) throw new Error('login required'); return { id: 'recovered' }; } });
  await pool.refill();
  assert.equal(pool.snapshot().retryAt, 10);
  t.mock.timers.tick(10);
  await pool.refill();
  assert.equal(pool.snapshot().retryAt, 30);
  t.mock.timers.tick(20);
  await pool.refill();
  assert.equal(calls, 3);
  assert.equal(pool.snapshot().unavailable, true);
  t.mock.timers.tick(100_000);
  assert.equal(pool.acquire(), null);
  await pool.refill();
  assert.equal(calls, 3, 'ordinary requests cannot reopen the failed pool');
  available = true;
  await pool.retry();
  assert.equal(pool.snapshot().unavailable, false);
  assert.equal(pool.snapshot().failures, 0);
  assert.equal(pool.snapshot().ready[0].id, 'recovered');
});
