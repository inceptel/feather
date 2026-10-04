import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSelfUpdateTool, piDirFor, readState, relaunchReport, RELAUNCH_EXIT_CODE, runLauncher, selfmodEnabled, shippedCommit, writeState } from '../src/selfmod.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-selfmod-'));
const SHIPPED = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);

// A stand-in main.js: logs its start, then follows the next step of plan.json.
const FAKE_MAIN = `
import fs from 'node:fs'; import path from 'node:path';
const dir = process.argv[process.argv.indexOf('--session-dir') + 1];
const sha = process.env.FEATHER_PI_CODE_SHA;
fs.appendFileSync(path.join(dir, 'runs.log'), sha.slice(0, 1) + '\\n');
const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
const step = plan.shift() || { ready: true, exit: 0 };
fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
if (step.state) fs.writeFileSync(path.join(dir, 'code', 'state.json'), JSON.stringify(step.state));
if (step.ready) fs.writeFileSync(path.join(dir, 'code', 'ready.json'), JSON.stringify({ sha, at: new Date().toISOString() }));
setTimeout(() => process.exit(step.exit), step.wait ?? 20);
`;

function fixture(plan, codeFor = [NEW, NEWER]) {
  const root = tmp();
  const shippedPiDir = path.join(root, 'releases', SHIPPED, 'agents', 'pi');
  fs.mkdirSync(path.join(shippedPiDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(shippedPiDir, 'src', 'main.js'), FAKE_MAIN);
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(path.join(sessionDir, 'code'), { recursive: true });
  for (const sha of codeFor) {
    fs.mkdirSync(path.join(piDirFor(sessionDir, sha), 'src'), { recursive: true });
    fs.writeFileSync(path.join(piDirFor(sessionDir, sha), 'src', 'main.js'), FAKE_MAIN);
  }
  fs.writeFileSync(path.join(sessionDir, 'plan.json'), JSON.stringify(plan));
  const runs = () => fs.readFileSync(path.join(sessionDir, 'runs.log'), 'utf8').trim().split('\n');
  const launch = (options = {}) => runLauncher({ sessionDir, shippedPiDir, args: ['--session-dir', sessionDir], env: { ...process.env, FEATHER_PI_SHIPPED_SHA: '' }, log: () => {}, readyTimeoutMs: 3000, ...options });
  return { sessionDir, shippedPiDir, runs, launch };
}

const asks = sha => ({ base: SHIPPED, candidate: sha, bad: {}, last: { kind: 'relaunch', sha, from: SHIPPED, changes: 'x', at: new Date().toISOString() } });

test('self-update is on unless switched off; the shipped commit is the release dir name', () => {
  assert.equal(selfmodEnabled({}), true);
  assert.equal(selfmodEnabled({ FEATHER_PI_SELFMOD: 'off' }), false);
  assert.equal(shippedCommit(`/x/releases/${SHIPPED}/agents/pi`, {}), SHIPPED);
  assert.equal(shippedCommit('/home/user/feather/agents/pi', {}), null);
});

test('launcher runs the shipped code and passes its exit code through', async () => {
  const f = fixture([{ ready: true, exit: 0 }]);
  assert.equal(await f.launch(), 0);
  assert.deepEqual(f.runs(), ['a']);
  const g = fixture([{ ready: true, exit: 4 }]);
  assert.equal(await g.launch(), 4);
});

test('launcher relaunches on request and keeps a candidate that starts', async () => {
  const f = fixture([{ ready: true, state: asks(NEW), exit: RELAUNCH_EXIT_CODE }, { ready: true, exit: 0 }]);
  assert.equal(await f.launch(), 0);
  assert.deepEqual(f.runs(), ['a', 'b']);
  const state = readState(f.sessionDir);
  assert.equal(state.good, NEW);
  assert.equal(state.candidate, null);
  // The next start runs the good code again.
  fs.writeFileSync(path.join(f.sessionDir, 'plan.json'), '[]');
  await f.launch();
  assert.deepEqual(f.runs(), ['a', 'b', 'b']);
});

test('launcher rolls back a candidate that exits before it is ready', async () => {
  const f = fixture([{ ready: true, state: asks(NEW), exit: RELAUNCH_EXIT_CODE }, { ready: false, exit: 1 }, { ready: true, exit: 0 }]);
  assert.equal(await f.launch(), 0);
  assert.deepEqual(f.runs(), ['a', 'b', 'a']);
  const state = readState(f.sessionDir);
  assert.equal(state.good ?? null, null);
  assert.match(state.bad[NEW], /exited \(1\) before it was ready/);
  assert.equal(state.last.kind, 'rollback');
  assert.match(relaunchReport(f.sessionDir, SHIPPED).text, /bbbbbbbb failed to start .* Rolled back to aaaaaaaa/);
});

test('launcher rolls back a candidate that never reports ready', async () => {
  const f = fixture([{ ready: true, state: asks(NEW), exit: RELAUNCH_EXIT_CODE }, { ready: false, exit: 0, wait: 60000 }, { ready: true, exit: 0 }]);
  assert.equal(await f.launch({ readyTimeoutMs: 600 }), 0);
  assert.deepEqual(f.runs(), ['a', 'b', 'a']);
  assert.match(readState(f.sessionDir).bad[NEW], /did not report ready/);
});

test('a failed candidate falls back to the last good self-update, not further', async () => {
  const f = fixture([{ ready: true, state: { ...asks(NEWER), good: NEW }, exit: RELAUNCH_EXIT_CODE }, { ready: false, exit: 1 }, { ready: true, exit: 0 }]);
  writeState(f.sessionDir, { base: SHIPPED, good: NEW, bad: {} });
  assert.equal(await f.launch(), 0);
  assert.deepEqual(f.runs(), ['b', 'c', 'b']);
  assert.equal(readState(f.sessionDir).good, NEW);
});

test('a Feather deploy wins: self-built code on another base is dropped', async () => {
  const f = fixture([{ ready: true, exit: 0 }]);
  writeState(f.sessionDir, { base: 'd'.repeat(40), good: NEW, bad: {} });
  assert.equal(await f.launch(), 0);
  assert.deepEqual(f.runs(), ['a']);
  assert.equal(readState(f.sessionDir).good ?? null, null);
});

// A tiny repo with an agents/pi package, and a "release" of its first commit.
function repoFixture() {
  const root = tmp();
  const repo = path.join(root, 'repo');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(repo, 'agents', 'pi', 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'feather\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(repo, 'agents', 'pi', 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test test/*.test.js' } }));
  fs.writeFileSync(path.join(repo, 'agents', 'pi', 'test', 'ok.test.js'), "import test from 'node:test'; test('ok', () => {});\n");
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const shippedPiDir = path.join(root, 'releases', base, 'agents', 'pi');
  fs.mkdirSync(path.join(shippedPiDir, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(shippedPiDir, 'node_modules', 'dep', 'index.js'), '');
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir);
  const exits = [];
  let exited = () => {};
  const tool = createSelfUpdateTool({ sessionDir, shippedPiDir, runningPiDir: shippedPiDir, repo, env: { ...process.env, FEATHER_PI_SHIPPED_SHA: '', FEATHER_PI_CODE_SHA: '' }, exit: code => { exits.push(code); exited(); }, testTimeoutMs: 60000 });
  const clone = path.join(sessionDir, 'selfmod');
  const commit = (file, body, message) => { fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true }); fs.writeFileSync(path.join(clone, file), body); git(clone, 'add', '-A'); git(clone, 'commit', '-qm', message); return git(clone, 'rev-parse', 'HEAD'); };
  const reset = () => git(clone, 'reset', '-q', '--hard', base);
  const call = args => {
    const ended = new Promise(resolve => { exited = () => setTimeout(() => resolve('pending'), 100); });
    return Promise.race([tool.execute(args), ended]);
  };
  return { base, sessionDir, clone, exits, commit, reset, call };
}
const text = result => result.content[0].text;

test('self_update: a worktree, then only a tested agents/pi commit relaunches', async () => {
  const f = repoFixture();
  assert.match(text(await f.call({ action: 'relaunch' })), /worktree" first/);
  const made = await f.call({ action: 'worktree' });
  assert.ok(!made.isError, text(made));
  assert.ok(fs.existsSync(path.join(f.clone, 'agents', 'pi', 'node_modules', 'dep', 'index.js')));

  f.commit('README.md', 'changed\n', 'outside');
  const outside = await f.call({ action: 'relaunch' });
  assert.equal(outside.isError, true);
  assert.match(text(outside), /outside agents\/pi\/: README\.md/);
  f.reset();

  f.commit('agents/pi/package.json', JSON.stringify({ type: 'module', scripts: { test: 'node --test test/*.test.js' }, dependencies: { x: '1' } }), 'deps');
  assert.match(text(await f.call({ action: 'relaunch' })), /changes agents\/pi\/package\.json/);
  f.reset();

  const failing = f.commit('agents/pi/test/bad.test.js', "import test from 'node:test'; import assert from 'node:assert'; test('bad', () => assert.fail('nope'));\n", 'failing test');
  const refused = await f.call({ action: 'relaunch' });
  assert.match(text(refused), /^Refused: npm test failed/);
  assert.ok(!fs.existsSync(piDirFor(f.sessionDir, failing)));
  f.reset();
  assert.deepEqual(f.exits, []);

  const good = f.commit('agents/pi/src/new.js', 'export const x = 1;\n', 'add new.js');
  assert.equal(await f.call({ action: 'relaunch' }), 'pending'); // the process ends inside the call
  assert.deepEqual(f.exits, [RELAUNCH_EXIT_CODE]);
  const state = readState(f.sessionDir);
  assert.equal(state.candidate, good);
  assert.equal(state.base, f.base);
  assert.ok(fs.existsSync(path.join(piDirFor(f.sessionDir, good), 'src', 'new.js')));
  assert.ok(fs.existsSync(path.join(piDirFor(f.sessionDir, good), 'node_modules', 'dep', 'index.js')));
  const report = relaunchReport(f.sessionDir, good);
  assert.match(report.text, /Relaunched on .{8} \(was .{8}\)\. Changes:\n.* add new\.js\n1 file changed/);
  assert.equal(relaunchReport(f.sessionDir, f.base), null); // not running it yet: no report

  // A commit that failed before is refused at once.
  writeState(f.sessionDir, { ...state, candidate: null, bad: { [failing]: 'it exited (1) before it was ready' } });
  assert.match(text(await f.call({ action: 'relaunch', commit: failing })), /failed before/);
  assert.match(text(await f.call({ action: 'status' })), /"shipped": "[0-9a-f]{40}"/);
});
