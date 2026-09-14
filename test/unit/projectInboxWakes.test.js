import test from 'node:test';
import assert from 'node:assert/strict';
import { projectInboxWakeIds } from '../../lib/project-inbox-wakes.js';

const project = { projectId: 'p', config: { objective: 'Tic tac toe' }, tasks: [{ id: 'board', status: 'queued', owner: null, dependsOn: [] }] };
const chat = status => ({ chatProjectId: 'p', chatRole: 'creator', mode: 'ralph', ralph: { status, enabled: !['blocked', 'stopped', 'complete'].includes(status) } });
test('human task input wakes a fresh Ralph awaiting an objective, but never overrides Stop', () => {
  assert.deepEqual(projectInboxWakeIds(project, { a: chat('blocked'), b: chat('stopped') }, { human: true, action: 'add' }), ['a']);
  assert.deepEqual(projectInboxWakeIds(project, { a: chat('blocked') }, { action: 'add' }), []);
});
test('work arriving during a turn is recovered by checking again at its waiting boundary', () => {
  assert.deepEqual(projectInboxWakeIds(project, { a: chat('working') }, { action: 'add' }), []);
  assert.deepEqual(projectInboxWakeIds(project, { a: chat('waiting') }), ['a']);
});
test('review waits and unready dependencies do not create automatic busy loops', () => {
  for (const status of ['agreeing', 'building', 'reviewing', 'approved', 'blocked']) {
    const owned = { ...project, tasks: [...project.tasks, { id: 'own', owner: 'a', status, dependsOn: [] }] };
    assert.deepEqual(projectInboxWakeIds(owned, { a: chat('waiting') }), []);
  }
  assert.deepEqual(projectInboxWakeIds({ ...project, tasks: [{ ...project.tasks[0], dependsOn: ['unfinished'] }] }, { a: chat('waiting') }), []);
});
test('unblocking resumes only the owning blocked pair after task state is cleared', () => {
  const reopened = { ...project, tasks: [{ id: 'board', owner: 'a', status: 'agreeing', dependsOn: [] }] };
  assert.deepEqual(projectInboxWakeIds(reopened, { a: chat('blocked'), b: chat('blocked') }, { human: true, action: 'unblock' }), ['a']);
  assert.deepEqual(projectInboxWakeIds(reopened, { a: chat('blocked') }, { human: true, action: 'add' }), []);
});
