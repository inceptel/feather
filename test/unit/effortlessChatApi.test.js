import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { freePort } from './freePort.js';

test('ready chats, idempotent cold creation and same-chat workflow survive Stop and restart', { timeout: 120_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-effortless-api-'));
  const home = path.join(root, 'home'), stateDir = path.join(root, 'state'), bin = path.join(root, 'bin');
  for (const dir of [home, stateDir, bin]) fs.mkdirSync(dir);
  const registry = path.join(root, 'panes.json');
  fs.writeFileSync(registry, '{}');
  const config = path.join(root, 'chat-config.json');
  fs.writeFileSync(config, JSON.stringify({ creator: { agent: 'claude', model: 'synthetic-creator' },
    reviewer: { agent: 'claude', model: 'synthetic-reviewer' }, standbyPairs: 1, reviewPolicy: 'adaptive' }), { mode: 0o600 });
  // Simulate visible paste and submission changes; the fixture does not invoke
  // any real harness, provider, private transcript or user project.
  fs.writeFileSync(path.join(bin, 'tmux'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), file = process.env.TMUX_REG;
const panes = JSON.parse(fs.readFileSync(file, 'utf8'));
const flag = name => args[args.indexOf(name) + 1];
const target = flag('-t');
switch (args[0]) {
  case 'has-session': process.exit(Object.hasOwn(panes, target) ? 0 : 1);
  case 'list-sessions': for (const name of Object.keys(panes)) process.stdout.write(name + '|0\\n'); break;
  case 'new-session': panes[flag('-s')] = 0; break;
  case 'kill-session': delete panes[target]; break;
  case 'capture-pane': if (!Object.hasOwn(panes, target)) process.exit(1); process.stdout.write('Composer ' + panes[target]); break;
  case 'paste-buffer': case 'send-keys': if (Object.hasOwn(panes, target)) panes[target]++; break;
}
fs.writeFileSync(file, JSON.stringify(panes));
`, { mode: 0o755 });

  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  let child, logs = '';
  const meta = () => {
    try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'session-meta.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  };
  async function until(check, label, timeout = 20_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Server exited: ${logs}`);
      const result = await check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Timed out: ${label}\n${logs}`);
  }
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: { ...process.env, HOME: home, FEATHER_STATE_DIR: stateDir,
        FEATHER_PROJECTS_DIR: path.join(home, 'projects'), FEATHER_WIKI_DIR: path.join(home, 'wiki'),
        FEATHER_CHAT_CONFIG: config, FEATHER_CHAT_POOL_SIZE: '1', FEATHER_ROOM_PULSES: '0',
        FEATHER_SCHEDULER: '0', FEATHER_PROJECT_COMMS_ENABLED: '0', FEATHER_READ_ONLY: '0',
        FEATHER_TMUX_READY_TIMEOUT_MS: '20', PORT: String(port), PATH: `${bin}:${process.env.PATH}`, TMUX_REG: registry },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', chunk => { logs += chunk; });
    await until(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'server health');
  }
  async function stop() {
    if (child?.exitCode === null) { child.kill(); await once(child, 'exit'); }
  }
  t.after(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); });
  async function request(route, body, headers = {}) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  async function ok(route, body, headers) {
    const result = await request(route, body, headers);
    assert.ok(result.status >= 200 && result.status < 300, `${route}: ${JSON.stringify(result)}`);
    return result.body;
  }
  const readyStandby = () => Object.entries(meta()).find(([, entry]) => entry.chatRole === 'creator'
    && entry.chatStandby === true && entry.chatStartup?.status === 'ready');
  const token = id => fs.readFileSync(path.join(home, '.feather/omp-sessions/.feather-bridge-tokens',
    createHash('sha256').update(id).digest('hex')), 'utf8').trim();
  const bridge = (id, input) => request(`/api/internal/sessions/${id}/workflow`, input,
    { 'X-Feather-Bridge-Token': token(id) });
  const workflow = result => result.workflow || result.state || result;

  await start();
  const [standbyId, standby] = await until(readyStandby, 'first ready pair');
  for (const query of ['', '?q=New', `?id=${standbyId}`, `?q=${standbyId}`]) {
    const listing = await ok(`/api/sessions${query}`);
    assert.ok(!listing.sessions.some(session => session.id === standbyId || session.id === standby.chatPair.reviewerSessionId));
  }
  assert.equal((await request(`/api/chats/${standbyId}/status`)).status, 404);
  const first = await ok('/api/chats', { requestId: 'warm-creation-one' });
  assert.equal(first.id, standbyId);
  assert.equal(first.status, 'ready');
  assert.equal(meta()[first.id].model, 'synthetic-creator');
  assert.equal(meta()[first.reviewerSessionId].model, 'synthetic-reviewer');
  const [secondReadyId] = await until(readyStandby, 'replacement ready pair');
  const second = await ok('/api/chats', { requestId: 'warm-creation-two' });
  assert.equal(second.id, secondReadyId);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.cwd, first.cwd);

  const claimTimes = [], claimedIds = new Set([first.id, second.id]);
  for (let trial = 0; trial < 20; trial++) {
    const [readyId] = await until(readyStandby, `isolated ready-pool trial ${trial}`);
    const startedAt = performance.now();
    const claimed = await ok('/api/chats', { requestId: `measured-warm-claim-${trial}` });
    claimTimes.push(performance.now() - startedAt);
    assert.equal(claimed.id, readyId);
    assert.equal(claimed.status, 'ready');
    assert.ok(!claimedIds.has(claimed.id), 'each isolated claim receives an unused identity');
    claimedIds.add(claimed.id);
  }
  const p95 = [...claimTimes].sort((a, b) => a - b)[Math.ceil(claimTimes.length * 0.95) - 1];
  t.diagnostic(`Synthetic stub API warm-claim p95 over 20 isolated ready trials: ${p95.toFixed(1)}ms (excludes real-agent readiness and first response)`);
  assert.ok(p95 < 1000, `Warm-claim API p95 was ${p95.toFixed(1)}ms`);

  assert.equal((await request('/api/chats', { standby: true })).status, 400);
  assert.equal((await request('/api/chats', { standby: false })).status, 400);
  const [availableWarmId] = await until(readyStandby, 'standby before explicit overrides');
  for (const [index, override] of [{ model: 'explicit-creator' }, { progressIntervalMinutes: 1 }].entries()) {
    const explicit = await request('/api/chats', { requestId: `explicit-options-${index}`, ...override });
    assert.equal(explicit.status, 202, 'explicit options cannot silently claim default-policy standby');
    assert.notEqual(explicit.body.id, availableWarmId);
    await until(async () => (await ok(`/api/chats/${explicit.body.id}/status`)).status === 'ready', 'explicit options ready');
    const saved = meta()[explicit.body.id];
    for (const [key, value] of Object.entries(override)) assert.equal(saved[key], value);
    assert.equal(meta()[availableWarmId].chatStandby, true);
  }

  const deleting = await request('/api/chats', { requestId: 'delete-during-startup', name: 'Cancelled synthetic startup' });
  assert.equal(deleting.status, 202);
  await ok(`/api/sessions/${deleting.body.id}/delete`, {});
  await until(() => {
    const panes = JSON.parse(fs.readFileSync(registry, 'utf8'));
    return !Object.hasOwn(panes, `feather-${deleting.body.id.slice(0, 8)}`)
      && !Object.hasOwn(panes, `feather-${deleting.body.reviewerSessionId.slice(0, 8)}`);
  }, 'cancelled pair processes removed');
  assert.equal(meta()[deleting.body.id], undefined);
  assert.equal((await request(`/api/chats/${deleting.body.id}/status`)).status, 404);

  const coldInput = { requestId: 'cold-creation-unique', name: 'Synthetic bounded analysis' };
  const [coldResponse, duplicateResponse] = await Promise.all([request('/api/chats', coldInput), request('/api/chats', coldInput)]);
  assert.equal(coldResponse.status, 202);
  const cold = coldResponse.body;
  assert.equal(duplicateResponse.body.id, cold.id);
  assert.equal((await request('/api/chats', { ...coldInput, name: 'Different objective' })).status, 409);
  const startingListing = await ok(`/api/sessions?id=${cold.id}`);
  assert.ok(startingListing.sessions.some(session => session.id === cold.id), 'allocated creator is visible before a transcript exists');
  await until(async () => (await ok(`/api/chats/${cold.id}/status`)).status === 'ready', 'cold pair ready');
  for (const query of ['', `?q=${cold.reviewerSessionId}`, `?id=${cold.reviewerSessionId}`]) {
    const listing = await ok(`/api/sessions${query}`);
    assert.ok(!listing.sessions.some(session => session.id === cold.reviewerSessionId), 'reviewer stays internal');
  }

  await ok(`/api/sessions/${cold.id}/send`, { text: 'Investigate only the synthetic comparison discussed here.' }, { 'X-Feather-Message-ID': 'human-objective-one' });
  const read = await bridge(cold.id, { action: 'read' });
  assert.equal(read.status, 200);
  const generation = workflow(read.body).generation;
  const startInput = { action: 'start', generation, objective: 'Compare synthetic fixture options', constraints: ['Use synthetic data only'], next: 'Check the supplied fixture' };
  const activated = await bridge(cold.id, startInput);
  assert.equal(activated.status, 200);
  assert.equal(workflow(activated.body).enabled, true);
  assert.equal(meta()[cold.id].mode, 'ralph');
  assert.equal(meta()[cold.reviewerSessionId].mode, undefined);
  assert.equal((await bridge(cold.reviewerSessionId, startInput)).status, 403);
  assert.equal((await request(`/api/internal/sessions/${cold.id}/workflow`, startInput,
    { 'X-Feather-Bridge-Token': token(cold.reviewerSessionId) })).status, 403, 'capabilities cannot address another session');
  const repeated = await bridge(cold.id, startInput);
  assert.equal(repeated.status, 200);
  assert.equal(workflow(repeated.body).generation, generation);
  const progressInput = { action: 'progress', generation, checkpointId: 'synthetic-evidence-one',
    summary: 'Checked the two synthetic options', evidence: 'Fixture A = 2; fixture B = 3; arithmetic checked.',
    phase: 'working', next: 'Prepare the independently reviewed comparison', publish: true };
  const progress = await bridge(cold.id, progressInput);
  assert.equal(progress.status, 200);
  assert.equal(workflow(progress.body).summary, progressInput.summary);
  assert.equal((await bridge(cold.id, progressInput)).status, 200);
  assert.equal(meta()[cold.id].workflow.checkpoints.filter(checkpoint => checkpoint.id === progressInput.checkpointId).length, 1);
  const listing = await ok(`/api/sessions?id=${cold.id}`);
  assert.equal(listing.sessions.find(session => session.id === cold.id).workflow.enabled, true);

  await ok(`/api/sessions/${cold.id}/workflow`, { action: 'stop' });
  assert.equal((await bridge(cold.id, startInput)).status, 409, 'an in-flight old generation cannot override Stop');
  assert.equal(meta()[cold.id].workflow.enabled, false);
  assert.equal(meta()[cold.id].ralph.enabled, false);
  const changedDefaults = JSON.parse(fs.readFileSync(config, 'utf8'));
  changedDefaults.creator.model = 'new-machine-default';
  changedDefaults.progressIntervalMinutes = 30;
  fs.writeFileSync(config, JSON.stringify(changedDefaults), { mode: 0o600 });
  await stop();
  await start();
  const replay = await ok('/api/chats', coldInput);
  assert.equal(replay.id, cold.id);
  assert.equal(replay.cwd, cold.cwd);
  assert.equal(meta()[cold.id].model, 'synthetic-creator', 'retry identity is independent of changed machine defaults');
  assert.equal(meta()[cold.id].progressIntervalMinutes, 15);
  assert.equal(meta()[cold.id].workflow.enabled, false);
  assert.equal((await bridge(cold.id, startInput)).status, 409);
  const stopped = workflow((await bridge(cold.id, { action: 'read' })).body);
  assert.equal((await bridge(cold.id, { ...startInput, generation: stopped.generation })).status, 409,
    'reading a newer generation does not grant new human authority');
  await ok(`/api/sessions/${cold.id}/send`, { text: 'Continue the same synthetic comparison.' }, { 'X-Feather-Message-ID': 'human-objective-two' });
  const authorized = workflow((await bridge(cold.id, { action: 'read' })).body);
  const resumed = await bridge(cold.id, { ...startInput, generation: authorized.generation });
  assert.equal(resumed.status, 200);
  assert.equal(workflow(resumed.body).enabled, true);
  await ok(`/api/sessions/${cold.id}/workflow`, { action: 'stop' });
  const humanStarted = await ok(`/api/sessions/${cold.id}/workflow`, { action: 'start', objective: startInput.objective });
  assert.equal(workflow(humanStarted).enabled, true, 'visible control can resume this conversation directly');
  await ok(`/api/sessions/${cold.id}/workflow`, { action: 'stop' });

  // The initial control request must expose a cancellable state before the
  // creator has derived scope. A synthetic harness deliberately never calls start.
  const pendingRequest = request(`/api/sessions/${cold.id}/workflow`, { action: 'start' });
  await until(() => meta()[cold.id]?.workflow?.pendingStart, 'pending scope selection');
  const pendingGeneration = meta()[cold.id].workflow.generation;
  await ok(`/api/sessions/${cold.id}/workflow`, { action: 'stop' });
  const pendingResponse = await pendingRequest;
  assert.equal(pendingResponse.status, 200);
  assert.equal(meta()[cold.id].workflow.pendingStart, false);
  assert.equal(meta()[cold.id].workflow.enabled, false);
  assert.equal((await bridge(cold.id, { ...startInput, generation: pendingGeneration })).status, 409);

  const prompted = await ok('/api/chats', { name: 'Initial synthetic objective', prompt: 'Go compare the two synthetic examples.' });
  const initial = workflow((await bridge(prompted.id, { action: 'read' })).body);
  assert.ok(initial.generation > 0);
  assert.equal((await bridge(prompted.id, { ...startInput, generation: initial.generation })).status, 200,
    'initial user prompt grants authority without requiring another send');

  const orphan = await ok(`/api/sessions/${first.id}/workflow`, { action: 'start' });
  assert.equal(workflow(orphan).pendingStart, true);
  const orphanGeneration = workflow(orphan).generation;

  await stop();
  const transcriptDir = path.join(home, '.claude', 'projects', 'synthetic-recovery');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${prompted.id}.jsonl`), JSON.stringify({
    type: 'assistant', uuid: 'completed-while-offline', sessionId: prompted.id, cwd: prompted.cwd,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Verified synthetic comparison.\nRALPH_COMPLETE: Synthetic comparison finished.' }] },
  }) + '\n');
  await start();
  await until(() => meta()[first.id]?.workflow?.pendingStart === false, 'orphan pending start revoked');
  assert.equal(meta()[first.id].workflow.enabled, false);
  assert.equal(meta()[first.id].workflow.humanAuthorized, false);
  assert.ok(meta()[first.id].workflow.generation > orphanGeneration);
  assert.equal((await bridge(first.id, { ...startInput, generation: orphanGeneration })).status, 409,
    'an interrupted scope-selection request cannot activate after restart');
  await until(() => meta()[prompted.id]?.ralph?.status === 'complete', 'offline completion reconciliation');
  assert.equal(meta()[prompted.id].ralph.enabled, false);
  assert.equal(meta()[prompted.id].workflow.enabled, false);
  assert.equal(meta()[prompted.id].workflow.phase, 'complete');
  assert.equal(meta()[prompted.id].ralph.lastBoundaryKey, 'completed-while-offline');
  const iteration = meta()[prompted.id].ralph.iteration;
  const paneRevision = JSON.parse(fs.readFileSync(registry, 'utf8'))[`feather-${prompted.id.slice(0, 8)}`];
  await stop();
  await start();
  // Wait past recovery rather than asserting immediately after health becomes ready.
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(meta()[prompted.id].ralph.status, 'complete');
  assert.equal(meta()[prompted.id].ralph.iteration, iteration);
  assert.equal(JSON.parse(fs.readFileSync(registry, 'utf8'))[`feather-${prompted.id.slice(0, 8)}`], paneRevision,
    'completed boundary is not replayed as another callback after restart');
  assert.equal(meta()[deleting.body.id], undefined, 'cancelled startup never resurrects after restart');
});
