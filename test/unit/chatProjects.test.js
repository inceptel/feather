import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createProjectRenamer, managedChatProject } from '../../lib/chat-projects.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'old-name');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'keep.txt'), 'evidence');
  let meta = { a: { cwd, chatRole: 'creator', chatProjectId: 'a' }, ar: { cwd, chatRole: 'reviewer', chatProjectId: 'a' }, b: { cwd, chatRole: 'creator', chatProjectId: 'a' } };
  const file = path.join(root, 'rename.json');
  const deps = { root, file, readMeta: () => meta, saveMeta: fn => { meta = fn(meta); } };
  return { root, cwd, file, deps };
}

test('rename preserves original launch paths and moves every pair in a shared project', t => {
  const f = fixture(t);
  const renamer = createProjectRenamer(f.deps);
  const result = renamer.rename('b', 'Trading Lab');
  assert.equal(result.cwd, path.join(f.root, 'trading-lab'));
  assert.equal(fs.readFileSync(path.join(f.cwd, 'keep.txt'), 'utf8'), 'evidence');
  for (const entry of Object.values(f.deps.readMeta())) {
    assert.equal(entry.cwd, result.cwd);
    assert.equal(entry.harnessCwd, f.cwd);
  }
  createProjectRenamer(f.deps).recover();
  const second = renamer.rename('a', 'Trading renamed');
  assert.equal(fs.realpathSync(f.cwd), second.cwd);
  assert.equal(f.deps.readMeta().a.harnessCwd, f.cwd);
  assert.equal(managedChatProject(f.root, f.deps.readMeta(), 'b').projectId, 'a');
});

test('restart completes a rename interrupted after the folder moved', t => {
  const f = fixture(t);
  const to = path.join(f.root, 'new-name');
  fs.writeFileSync(f.file, JSON.stringify({ pending: { from: f.cwd, to, ids: ['a', 'ar', 'b'] } }));
  fs.renameSync(f.cwd, to);
  createProjectRenamer(f.deps).recover();
  assert.equal(fs.realpathSync(f.cwd), to);
  assert.equal(f.deps.readMeta().a.cwd, to);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).pending, null);
});

test('rename rejects occupied names and nonproject chats without changing files', t => {
  const f = fixture(t);
  const renamer = createProjectRenamer(f.deps);
  fs.mkdirSync(path.join(f.root, 'taken'));
  assert.throws(() => renamer.rename('a', 'taken'), { status: 409 });
  assert.throws(() => renamer.rename('ar', 'new'), { status: 404 });
  assert.equal(fs.readFileSync(path.join(f.cwd, 'keep.txt'), 'utf8'), 'evidence');
});

test('an active process and a restarted process can use the original folder after rename', async t => {
  const f = fixture(t);
  const script = path.join(f.root, 'reader.cjs');
  fs.writeFileSync(script, `const fs = require('fs'); process.on('message', old => process.send([fs.readFileSync('keep.txt', 'utf8'), fs.readFileSync(old + '/keep.txt', 'utf8')])); process.send('ready');`);
  const start = async cwd => {
    const child = fork(script, [], { cwd, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    t.after(() => child.kill());
    await once(child, 'message');
    return child;
  };
  const running = await start(f.cwd);
  createProjectRenamer(f.deps).rename('a', 'live-renamed');
  running.send(f.cwd);
  assert.deepEqual((await once(running, 'message'))[0], ['evidence', 'evidence']);
  running.kill();
  await once(running, 'exit');
  const restarted = await start(f.deps.readMeta().a.harnessCwd);
  restarted.send(f.cwd);
  assert.deepEqual((await once(restarted, 'message'))[0], ['evidence', 'evidence']);
});
