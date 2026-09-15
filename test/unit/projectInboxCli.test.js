import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const cli = new URL('../../bin/feather-inbox.mjs', import.meta.url).pathname;
function invoke(args, env, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, FEATHER_BRIDGE_URL: '', FEATHER_BRIDGE_TOKEN: '', FEATHER_SESSION_ID: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test('inbox CLI uses the exact authenticated instance and supports JSON, file and stdin', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, token: req.headers['x-feather-bridge-token'], body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ task: { id: 'example' } }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-inbox-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'input.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'From file' }));
  const env = { FEATHER_BRIDGE_URL: `http://127.0.0.1:${server.address().port}/bridge`,
    FEATHER_BRIDGE_TOKEN: 'test-capability', FEATHER_SESSION_ID: 'creator', FEATHER_URL: 'http://127.0.0.1:1' };
  for (const [args, input] of [
    [['claim', '{"taskId":"example"}'], ''],
    [['add', '--file', file], ''],
    [['propose', '--stdin'], '{"taskId":"example","criteria":["Works"]}'],
  ]) {
    const result = await invoke(args, env, input);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { task: { id: 'example' } });
  }
  assert.ok(requests.every(req => req.url === '/api/internal/sessions/creator/inbox' && req.token === 'test-capability'));
  assert.deepEqual(requests.map(req => req.body), [
    { taskId: 'example', action: 'claim' }, { title: 'From file', action: 'add' },
    { taskId: 'example', criteria: ['Works'], action: 'propose' },
  ]);
});

test('inbox CLI fails closed without identity and reports invalid JSON and API errors', async t => {
  const missing = await invoke(['read'], {});
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /bridge capability/);
  const env = { FEATHER_BRIDGE_URL: 'http://127.0.0.1:1', FEATHER_BRIDGE_TOKEN: 'test', FEATHER_SESSION_ID: 'creator' };
  const malformed = await invoke(['add', '{invalid'], env);
  assert.equal(malformed.code, 1);
  assert.equal(malformed.stdout, '');
  const server = http.createServer((_req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Pair already owns unfinished task' }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const rejected = await invoke(['claim'], { ...env, FEATHER_BRIDGE_URL: `http://127.0.0.1:${server.address().port}` });
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /Pair already owns unfinished task/);
  assert.equal(rejected.stdout, '');
});
