import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProjectInbox } from '../../lib/project-inbox.js'

const human = { sessionId: 'user', role: 'human' }
const creator = { sessionId: 'creator-a', creatorSessionId: 'creator-a', role: 'creator' }
const reviewer = { sessionId: 'reviewer-a', creatorSessionId: 'creator-a', role: 'reviewer' }
const other = { sessionId: 'creator-b', creatorSessionId: 'creator-b', role: 'creator' }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-inbox-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = createProjectInbox({ root })
  store.configure('project', { objective: 'Build tic tac toe', allowIdeas: true, maxGeneratedTasks: 1 }, human)
  return { root, store }
}
const add = (store, id = 'board', dependsOn = []) => store.add('project', { id, title: id, description: 'A tested game feature', dependsOn }, human)
const move = (store, action, input = {}, actor = creator) => store.transition('project', 'board', action, input, actor)

test('agreement, rejected candidate, correction, independent approval and idempotent completion persist', t => {
  const { store, root } = fixture(t)
  add(store)
  assert.equal(store.claim('project', creator).status, 'agreeing')
  assert.throws(() => move(store, 'submit', { revision: 'v1' }))
  move(store, 'propose', { criteria: ['All eight winning lines detected'] })
  move(store, 'agree', {}, reviewer)
  move(store, 'submit', { revision: 'v1' })
  move(store, 'review', { revision: 'v1', verdict: 'REVISE', evidence: 'Diagonal test fails' }, reviewer)
  assert.throws(() => move(store, 'complete', { revision: 'v1', result: { summary: 'Done', evidence: 'Trust me' } }))
  assert.throws(() => move(store, 'submit', { revision: 'v1' }))
  move(store, 'submit', { revision: 'v2' })
  assert.throws(() => move(store, 'review', { revision: 'v1', verdict: 'PASS', evidence: 'Old results' }, reviewer))
  move(store, 'review', { revision: 'v2', verdict: 'PASS', evidence: 'All eight win tests pass' }, reviewer)
  const input = { revision: 'v2', result: { summary: 'Win detection finished', evidence: 'tests/wins.html', wiki: 'wiki/game.md' } }
  const done = move(store, 'complete', input)
  assert.equal(done.status, 'done')
  assert.deepEqual(move(store, 'complete', input), done)
  assert.deepEqual(createProjectInbox({ root }).read('project').tasks[0], done)
  assert.equal(done.history.filter(event => event.action === 'review').length, 2)
  assert.ok(done.history.every(event => !Number.isNaN(Date.parse(event.at))))
})

test('competing claims are exclusive, dependent tasks wait, ownership survives restart', t => {
  const { store, root } = fixture(t)
  add(store); add(store, 'reset', ['board']); add(store, 'styles')
  assert.equal(store.claim('project', creator).id, 'board')
  const resumed = createProjectInbox({ root })
  assert.equal(resumed.claim('project', creator).id, 'board')
  assert.equal(resumed.claim('project', other).id, 'styles')
  assert.throws(() => store.claim('project', creator, { taskId: 'reset' }))
  const third = { role: 'creator', sessionId: 'c', creatorSessionId: 'c' }
  assert.equal(store.claim('project', third), null)
  move(store, 'propose', { criteria: ['Works'] }); move(store, 'agree', {}, reviewer)
  move(store, 'submit', { revision: '1' }); move(store, 'review', { revision: '1', verdict: 'PASS', evidence: 'Browser check' }, reviewer)
  move(store, 'complete', { revision: '1', result: { summary: 'Done', evidence: 'Browser check' } })
  assert.equal(store.claim('project', creator).id, 'reset')
})

test('pair role and ownership boundaries reject self approval and other pairs', t => {
  const { store } = fixture(t)
  add(store); store.claim('project', creator)
  move(store, 'propose', { criteria: ['Works'] })
  assert.throws(() => move(store, 'agree', {}, creator))
  assert.throws(() => move(store, 'agree', {}, { ...reviewer, sessionId: creator.sessionId }))
  assert.throws(() => move(store, 'agree', {}, { ...reviewer, creatorSessionId: other.sessionId }))
  assert.throws(() => move(store, 'block', { reason: 'No' }, other))
  assert.throws(() => store.claim('project', reviewer))
  assert.throws(() => store.claim('project', { ...creator, sessionId: 'fake' }))
  assert.throws(() => store.configure('project', { objective: 'Changed', allowIdeas: true }, creator))
})

test('blocking preserves reason and reopening demands fresh agreement', t => {
  const { store } = fixture(t)
  add(store); store.claim('project', creator)
  move(store, 'propose', { criteria: ['Works'] }); move(store, 'agree', {}, reviewer)
  move(store, 'submit', { revision: '1' }); move(store, 'review', { revision: '1', verdict: 'PASS', evidence: 'Browser check' }, reviewer)
  const blocked = move(store, 'block', { reason: 'Missing file' })
  assert.equal(blocked.history.at(-1).reason, 'Missing file')
  assert.equal(store.claim('project', creator).status, 'blocked')
  assert.throws(() => move(store, 'unblock', {}, reviewer))
  const reopened = move(store, 'unblock', {}, human)
  assert.equal(reopened.status, 'agreeing'); assert.equal(reopened.review, null); assert.equal(reopened.revision, null)
  assert.throws(() => move(store, 'agree', {}, reviewer))
})

test('generated ideas obey durable cap and duplicate IDs are content-idempotent', t => {
  const { store, root } = fixture(t)
  const input = { id: 'idea', title: 'Sound', description: 'Optional win sound' }
  assert.deepEqual(store.add('project', input, creator), store.add('project', input, creator))
  assert.throws(() => createProjectInbox({ root }).add('project', { ...input, id: 'idea2' }, creator))
  assert.throws(() => store.add('project', { ...input, title: 'Different' }, creator))
  assert.throws(() => store.add('project', input, reviewer))
  store.configure('project', { objective: 'Only assigned work', allowIdeas: false }, human)
  assert.throws(() => store.add('project', { ...input, id: 'idea2' }, creator))
  assert.equal(store.add('project', { ...input, id: 'human-idea' }, human).source, 'human')
})

test('invalid inputs and malformed or structurally corrupt state fail closed', t => {
  const { store, root } = fixture(t)
  for (const project of ['../escape', '/', '', 'x'.repeat(129)]) assert.throws(() => store.read(project))
  assert.throws(() => store.add('missing', { title: 'Task', description: 'Details' }, human))
  for (const input of [null, {}, { title: '', description: 'x' }, { title: 'x', description: 'x', id: '../bad' }, { title: 'x', description: 'x', dependsOn: ['missing'] }]) assert.throws(() => store.add('project', input, human))
  assert.throws(() => store.add('project', { id: 'self', title: 'x', description: 'x', dependsOn: ['self'] }, human))
  assert.throws(() => store.configure('project', { objective: 'x', allowIdeas: true, maxGeneratedTasks: -1 }, human))
  add(store); store.claim('project', creator)
  assert.throws(() => move(store, 'propose', { criteria: [] }))
  assert.throws(() => move(store, 'surprise'))
  assert.throws(() => store.transition('project', 'missing', 'block', { reason: 'x' }, creator))
  fs.writeFileSync(path.join(root, 'project.json'), '{broken')
  assert.throws(() => store.read('project'), /malformed/)
  assert.throws(() => add(store, 'another'), /malformed/)
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ version: 1, projectId: 'project', config: null, tasks: [{ id: 'bad' }] }))
  assert.throws(() => store.read('project'), /invalid/)
})

test('network retries do not repeat agreement, submissions, reviews or completion', t => {
  const { store } = fixture(t)
  const input = { id: 'board', title: 'Playable board' }
  const task = store.add('project', input, human)
  assert.equal(task.description, input.title)
  assert.deepEqual(store.add('project', { ...input, description: input.title }, human), task)
  store.claim('project', creator); move(store, 'propose', { criteria: ['Works'] })
  const agreed = move(store, 'agree', {}, reviewer)
  assert.deepEqual(move(store, 'agree', {}, reviewer), agreed)
  const submitted = move(store, 'submit', { revision: '1' })
  assert.deepEqual(move(store, 'submit', { revision: '1' }), submitted)
  const reject = { revision: '1', verdict: 'REVISE', evidence: 'Diagonal missing' }
  const rejected = move(store, 'review', reject, reviewer)
  assert.deepEqual(move(store, 'review', reject, reviewer), rejected)
  assert.throws(() => move(store, 'submit', { revision: '1' }), { status: 409 })
  assert.throws(() => move(store, 'review', { ...reject, evidence: 'Changed verdict' }, reviewer), { status: 409 })
  move(store, 'submit', { revision: '2' })
  assert.throws(() => move(store, 'review', reject, reviewer), { status: 409 })
  const pass = { revision: '2', verdict: 'PASS', evidence: 'Every line works' }
  const approved = move(store, 'review', pass, reviewer)
  assert.deepEqual(move(store, 'review', pass, reviewer), approved)
  const done = move(store, 'complete', { revision: '2', result: { summary: 'Finished', evidence: 'Tests' } })
  assert.deepEqual(move(store, 'complete', { revision: '2', result: { evidence: 'Tests', summary: 'Finished' } }), done)
})

test('API errors distinguish validation, permission, missing tasks and conflicts', t => {
  const { store } = fixture(t)
  assert.throws(() => store.read('../x'), { status: 400 })
  assert.throws(() => store.add('project', { title: '' }, human), { status: 400 })
  assert.throws(() => store.claim('project', reviewer), { status: 403 })
  assert.throws(() => store.claim('project', creator, { taskId: 'missing' }), { status: 404 })
  add(store); store.claim('project', creator)
  assert.throws(() => move(store, 'propose', { criteria: ['x'] }, other), { status: 403 })
  assert.throws(() => store.transition('project', 'missing', 'agree', {}, reviewer), { status: 404 })
  assert.throws(() => move(store, 'submit', { revision: '1' }), { status: 409 })
  assert.throws(() => move(store, 'propose', { criteria: [] }), { status: 400 })
  store.add('project', { id: 'idea', title: 'Idea' }, creator)
  assert.throws(() => store.add('project', { title: 'Another idea' }, creator), { status: 409 })
})

test('integrated changes invalidate prior approval and require review of the new revision', t => {
  const { store } = fixture(t)
  add(store); store.claim('project', creator)
  move(store, 'propose', { criteria: ['The integrated board works'] })
  move(store, 'agree', {}, reviewer)
  move(store, 'submit', { revision: 'branch-v1' })
  const approved = move(store, 'review', { revision: 'branch-v1', verdict: 'PASS', evidence: 'Branch browser checks passed' }, reviewer)
  assert.deepEqual(move(store, 'submit', { revision: 'branch-v1' }), approved)
  const integrated = move(store, 'submit', { revision: 'integrated-v2' })
  assert.equal(integrated.status, 'reviewing')
  assert.equal(integrated.review, null)
  assert.equal(integrated.revision, 'integrated-v2')
  const result = { summary: 'Integrated board', evidence: 'Integration browser checks' }
  assert.throws(() => move(store, 'complete', { revision: 'branch-v1', result }), { status: 409 })
  assert.throws(() => move(store, 'complete', { revision: 'integrated-v2', result }), { status: 409 })
  assert.throws(() => move(store, 'review', { revision: 'branch-v1', verdict: 'PASS', evidence: 'Old check' }, reviewer), { status: 409 })
  move(store, 'review', { revision: 'integrated-v2', verdict: 'PASS', evidence: 'Integration checks passed' }, reviewer)
  assert.throws(() => move(store, 'complete', { revision: 'branch-v1', result }), { status: 409 })
  assert.equal(move(store, 'complete', { revision: 'integrated-v2', result }).status, 'done')
})

test('audit history retains latest 1000 events and rejects oversized persisted history', t => {
  const { store, root } = fixture(t)
  add(store); store.claim('project', creator)
  const file = path.join(root, 'project.json')
  const doc = store.read('project')
  doc.tasks[0].history = Array.from({ length: 1000 }, (_, n) => ({ at: new Date().toISOString(), sessionId: 'user', action: `prior-${n}` }))
  fs.writeFileSync(file, JSON.stringify(doc))
  const proposed = move(store, 'propose', { criteria: ['Works'] })
  assert.equal(proposed.history.length, 1000)
  assert.equal(proposed.history[0].action, 'prior-1')
  assert.equal(proposed.history.at(-1).action, 'propose')
  const oversized = store.read('project')
  oversized.tasks[0].history.push(oversized.tasks[0].history[0])
  fs.writeFileSync(file, JSON.stringify(oversized))
  assert.throws(() => store.read('project'), /invalid/)
})
