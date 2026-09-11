import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createKeyedLock } from '../../lib/sendlock.js';
import { scheduledRunMayContinue } from '../../lib/autopilot.js';

const server = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const section = (start, end) => server.slice(server.indexOf(start), server.indexOf(end, server.indexOf(start)));
function fixture(overrides = {}) {
  const state = { rules: { rule: { enabled: true } }, runtime: {}, active: [{ runId: 'old' }] };
  const meta = { chat: { ralph: { enabled: true, status: 'working' } } };
  const pastes = [], events = [], keys = [];
  const context = vm.createContext({
    createKeyedLock, scheduledRunMayContinue, console,
    tmuxName: id => id, tmuxIsActive: () => true, tmuxCapture: () => 'pane',
    tmuxPaste: (...args) => pastes.push(args), tmuxRun: args => keys.push(args.at(-1)),
    waitForPaneChange: async () => true, pause: async () => {},
    readMeta: () => meta, getOmpSessionId: () => null,
    path: { join: (...parts) => parts.join('/') }, ROOMS_HOME_DIR: '/rooms',
    RESIDENT_RELAUNCH_SETTLE_MS: 1, sleep: async () => {}, launchOmpSession: () => {},
    ROOM_PULSE_STARTED_AT: 0,
    SCHEDULER_STATE: { read: () => state, update: fn => Object.assign(state, fn(state)) },
    schedulerWrapUpPrompt: () => 'Automatic wrap-up', getAgentForSession: () => 'claude',
    appendSchedulerRun: event => events.push(event), ...overrides,
  });
  vm.runInContext(section('const sendLock = createKeyedLock();', 'const ralphCallbackTimers = new Map();'), context);
  vm.runInContext(section('function residentWakeDue(', 'const residentWakesInFlight = new Set();'), context);
  vm.runInContext(section('async function ensureResidentRunning(', 'function checkResidentWakes()'), context);
  vm.runInContext(section('async function schedulerNudge(', 'function schedulerFinishRun('), context);
  return { context, state, meta, pastes, events, keys };
}

test('scheduled nudge queued behind a human send stays cancelled after rule restart', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = fixture({ waitForPaneChange: async () => { if (++calls === 1) { entered(); await gate; } return true; } });
  const human = f.context.sendInput('chat', 'Human message');
  await ready;
  const nudge = f.context.schedulerNudge({ runId: 'old', ruleId: 'rule', sessionId: 'chat' }, { id: 'rule' }, Date.now());
  f.state.active = [{ runId: 'new' }]; // Stop removes old run; subsequent restart is a different run.
  release();
  await Promise.all([human, nudge]);
  assert.equal(f.pastes.length, 1);
  assert.deepEqual(f.keys, ['Enter']);
  assert.equal(f.events.length, 0);
});

test('resident Stop followed by human re-enable invalidates an in-flight readiness wait', async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let launches = 0;
  const f = fixture({ tmuxIsActive: () => false, launchOmpSession: () => launches++, sleep: async () => { entered(); await gate; } });
  const wake = f.context.wakeResident('chat', 'room', 'Automatic wake');
  await ready;
  f.meta.chat.ralph = { enabled: true, status: 'working', stopToken: 'stopped-then-reenabled' };
  release();
  assert.equal((await wake).cancelled, true);
  assert.equal(launches, 1);
  assert.equal(f.pastes.length, 0);
});

test('explicitly stopped resident is not due and is never relaunched', async () => {
  let launches = 0;
  const f = fixture({ tmuxIsActive: () => false, launchOmpSession: () => launches++ });
  f.meta.chat.ralph = { enabled: false, status: 'stopped' };
  assert.equal(f.context.residentWakeDue({ wakeIntervalMs: 10 }, 'chat', f.meta, 100), false);
  assert.equal((await f.context.wakeResident('chat', 'room', 'Automatic wake')).cancelled, true);
  assert.equal(launches, 0);
  assert.equal(f.pastes.length, 0);
});

test('completed resident still supports its next automatic wake', async () => {
  const f = fixture();
  f.meta.chat.ralph = { enabled: false, status: 'complete' };
  assert.equal(f.context.residentWakeDue({ wakeIntervalMs: 10 }, 'chat', f.meta, 100), true);
  assert.equal((await f.context.wakeResident('chat', 'room', 'Automatic wake')).observed, true);
  assert.deepEqual(f.keys, ['Enter']);
});

test('scheduler cancellation before OMP wake prevents relaunch', async () => {
  let launches = 0;
  const f = fixture({ tmuxIsActive: () => false, launchOmpSession: () => launches++ });
  assert.equal((await f.context.wakeResident('chat', 'room', 'Scheduled wake', () => false)).cancelled, true);
  assert.equal(launches, 0);
});

for (const scenario of ['inject', 'fresh', 'round']) {
  test(`scheduled ${scenario} threads its original run guard into delivery`, async () => {
    const f = fixture({
      schedulerPrompt: () => 'Scheduled prompt', runtimeOf: () => ({}),
      schedulerTargetSessionId: () => 'chat', prepareRalphForHumanInput: () => {},
      ROOM_ASSIGN_STATE: { update: () => {} }, spawnSession: () => {}, updateMeta: () => {},
      ROOM_KICKOFF_DELAY_MS: 0,
      schedulerAgentLastMessage: () => ({ from: 'builder', ts: 0, seq: 1, text: 'Review this' }),
      AGENT_END_RE: /never-match/, DEFAULT_ROUND_MS: 100, formatDuration: String,
    });
    vm.runInContext(section('function schedulerAssertActive(', '// One agent = a builder chat'), f.context);
    vm.runInContext(section('async function schedulerAgentRoundCheck(', 'function schedulerRetireAgent('), f.context);
    const run = { runId: 'old', ruleId: 'rule', sessionId: 'chat', startedAt: new Date(0).toISOString(), agent: { checkerSessionId: 'chat' } };
    let checked = false;
    f.context.sendInput = async (_id, _text, maySend) => {
      assert.equal(typeof maySend, 'function');
      assert.equal(maySend(), true);
      f.state.active = [{ runId: 'new' }];
      assert.equal(maySend(), false);
      checked = true;
      return { cancelled: true };
    };
    if (scenario === 'inject') {
      await assert.rejects(f.context.schedulerLaunch({ id: 'rule', room: 'room', mode: 'inject', target: { kind: 'resident' } }, run), /stopped/);
    } else if (scenario === 'fresh') {
      await assert.rejects(f.context.schedulerStartFreshSession({ id: 'chat', cwd: '/room', room: 'room', engine: 'claude', title: 'Chat', prompt: 'Work', run }), /stopped/);
    } else {
      await f.context.schedulerAgentRoundCheck(run, { id: 'rule', room: 'room', target: {} }, 150);
    }
    assert.equal(checked, true);
    assert.equal(f.events.length, 0);
  });
}
