import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createKeyedLock } from '../../lib/sendlock.js';

// Exercise the actual server transport with inert panes: no harness processes.
const server = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const transport = server.slice(server.indexOf('const sendLock = createKeyedLock();'), server.indexOf('const ralphCallbackTimers = new Map();'));
function fixture(overrides = {}) {
  const keys = [], pastes = [];
  const context = vm.createContext({
    createKeyedLock, console, tmuxName: id => id, tmuxIsActive: () => true,
    tmuxCapture: () => 'pane', tmuxPaste: (...args) => pastes.push(args),
    tmuxRun: args => keys.push(args.at(-1)), waitForPaneChange: async () => true,
    pause: async () => {}, ...overrides,
  });
  vm.runInContext(transport, context);
  return { send: context.sendInput, keys, pastes };
}

test('Stop cancels a Ralph continuation queued behind another send', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0, enabled = true;
  const f = fixture({ waitForPaneChange: async () => { if (++calls === 1) { entered(); await gate; } return true; } });
  const first = f.send('chat', 'Human message');
  await ready;
  const pending = f.send('chat', 'Continue automatically', () => enabled);
  enabled = false;
  release();
  await first;
  assert.equal((await pending).cancelled, true);
  assert.equal(f.pastes.length, 1);
  assert.deepEqual(f.keys, ['Enter']);
});

test('Stop during observation leaves the already-submitted turn alone', async () => {
  let enabled = true;
  const f = fixture({ waitForPaneChange: async () => { enabled = false; return true; } });
  assert.equal((await f.send('chat', 'Continue', () => enabled)).cancelled, true);
  assert.equal(f.pastes.length, 1);
  assert.deepEqual(f.keys, ['Enter']);
});

test('Stop during resume readiness prevents the callback paste', async () => {
  let enabled = true;
  const f = fixture({ tmuxIsActive: () => false, resumeSession: () => {}, waitForPaneSettled: async () => { enabled = false; return true; } });
  assert.equal((await f.send('chat', 'Continue', () => enabled)).cancelled, true);
  assert.equal(f.pastes.length, 0);
  assert.deepEqual(f.keys, []);
});
