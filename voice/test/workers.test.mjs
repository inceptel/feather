#!/usr/bin/env node
// Worker-path tests: the voice server on a fake pi (no model, no Feather writes).
// Run: node voice/test/workers.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const PORT = 4939;
const V = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [join(here, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), MAX_WORKERS: '1', FAKE_SETUP_MS: '1500', PI_BIN: join(here, 'fake-pi.mjs'),
    AGENT_CWD: tmpdir(), HOME: mkdtempSync(join(tmpdir(), 'voice-test-')) },
  stdio: 'ignore',
});
process.on('exit', () => server.kill());
for (let i = 0; ; i++) {
  const h = await fetch(`${V}/healthz`).then(r => r.json(), () => null);
  if (h?.ready) break;
  if (i > 40) throw new Error('voice server did not start');
  await new Promise(r => setTimeout(r, 250));
}
const tool = async (name, args = {}, call_id) => (await fetch(`${V}/api/tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args, call_id }) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function done(id) {
  for (let i = 0; i < 60; i++) {
    const t = (await (await fetch(`${V}/api/tasks`)).json()).tasks.find(x => x.id === id);
    if (t && !['running', 'queued'].includes(t.status)) return t;
    await sleep(250);
  }
  throw new Error(`task ${id} never finished`);
}
let pass = 0, failN = 0;
async function test(name, fn) { try { await fn(); pass++; console.log(`ok   ${name}`); } catch (e) { failN++; console.log(`FAIL ${name}: ${e.message}`); } }

await test('refusal → error refused', async () => { const t = await done((await tool('ask_feather', { request: 'REFUSE' })).task_id); assert.equal(t.status, 'error'); assert.equal(t.error.code, 'refused'); });
await test('retry recovered → done', async () => { const t = await done((await tool('ask_feather', { request: 'FLAKY' })).task_id); assert.equal(t.status, 'done'); assert.match(t.report, /Recovered/); });
await test('retry recovered with empty reply → not an error', async () => { const t = await done((await tool('ask_feather', { request: 'EMPTYRETRY' })).task_id); assert.equal(t.status, 'done', JSON.stringify(t.error)); });
await test('connection refused → backend, not refused', async () => { const t = await done((await tool('ask_feather', { request: 'CONNREF' })).task_id); assert.equal(t.status, 'error'); assert.equal(t.error.code, 'backend'); });
await test('stop during session setup really stops', async () => {
  const a = await tool('ask_feather', { request: 'ECHO stopme' });
  await sleep(300);
  const s = await tool('stop_feather', { task_id: a.task_id }); assert.equal(s.ok, true, JSON.stringify(s));
  const t = await done(a.task_id); assert.equal(t.status, 'stopped', `status ${t.status}: ${t.report}`);
});
await test('follow-up during setup joins the first prompt', async () => {
  const a = await tool('ask_feather', { request: 'ECHO first' });
  await sleep(300);
  const f = await tool('ask_feather', { request: 'second part', task_id: a.task_id }); assert.equal(f.ok, true);
  const t = await done(a.task_id); assert.match(t.report, /second part/, t.report);
});
await test('same call id twice → one task', async () => {
  const [a, b] = await Promise.all([tool('ask_feather', { request: 'ECHO memo' }, 'memo1'), tool('ask_feather', { request: 'ECHO memo' }, 'memo1')]);
  assert.equal(a.task_id, b.task_id); await done(a.task_id);
});
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
