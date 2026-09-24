import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createProjectComms } from '../../lib/project-comms.js'
import { buildProjectCommsPrompt } from '../../lib/project-comms-prompts.js'

function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-comms-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let clock = 100000
  const config = { root, now: () => clock, coalesceMs: 0, ...options }
  let store = createProjectComms(config)
  return { get store() { return store }, advance(ms) { clock += ms }, restart() { store = createProjectComms(config) }, root }
}
const source = (n = 1, more = {}) => ({ id: `task-${n}`, projectId: 'game', projectTitle: 'Example Game', ownerSessionId: 'creator', kind: 'task-result', snapshot: { summary: `Improvement ${n}`, evidence: 'local browser verified' }, ...more })
function lease(store) { const j = store.leaseNext(); assert.ok(j); store.assign(j.id, j.leaseToken, 'helper'); return j }
function finish(store, j, output) { return store.complete(j.id, { leaseToken: j.leaseToken, sessionId: 'helper', output }) }
const candidate = { title: 'Better opponents', summary: 'Opponents react to your pricing.', evidence: 'Verified a round locally', links: [{ label: 'Play', url: 'https://example.com/game' }] }
function publish(store) {
  store.ingest(source()); finish(store, lease(store), { decision: 'publish', reason: 'Playable improvement', candidate })
  finish(store, lease(store), { title: candidate.title, summary: candidate.summary, links: candidate.links })
  return store.read().publications[0]
}

test('sources coalesce by stable project, deduplicate canonical snapshots and persist across restart', t => {
  const f = setup(t, { coalesceMs: 100 })
  f.store.ingest(source()); f.store.ingest(source(2)); assert.equal(f.store.read().jobs.length, 1)
  assert.equal(f.store.leaseNext(), null)
  f.restart(); assert.equal(f.store.ingest(source()).duplicate, true)
  assert.equal(f.store.read().sources.length, 2)
  f.advance(100); assert.equal(lease(f.store).payload.sources.length, 2)
  f.store.ingest(source(3)); assert.equal(f.store.read().jobs.length, 2)
})

test('only explicit caretaker approval reaches marketer; publishing callback retries exactly once', t => {
  const { store } = setup(t)
  store.ingest(source()); const caretaker = lease(store)
  assert.throws(() => finish(store, caretaker, candidate), /decision/)
  finish(store, caretaker, { decision: 'publish', reason: 'Meaningful', candidate })
  assert.equal(store.read().publications.length, 0)
  const marketer = lease(store); const output = { title: candidate.title, summary: candidate.summary }
  finish(store, marketer, output); finish(store, marketer, output)
  assert.equal(store.read().publications.length, 1)
  assert.throws(() => finish(store, marketer, { ...output, title: 'Changed' }), /Stale/)
})

test('suppression is durable and never publishes', t => {
  const f = setup(t); f.store.ingest(source()); finish(f.store, lease(f.store), { decision: 'suppress', reason: 'Only test churn', wikiPaths: [] })
  f.restart(); assert.equal(f.store.read().jobs.length, 1); assert.equal(f.store.read().publications.length, 0)
})

test('wrong session/token, expiration, bounded retries, pause and restart do not bypass leases', t => {
  const f = setup(t, { leaseMs: 100, maxAttempts: 2 }); f.store.ingest(source())
  const first = lease(f.store)
  assert.throws(() => f.store.complete(first.id, { leaseToken: first.leaseToken, sessionId: 'intruder', output: { decision: 'suppress', reason: 'No' } }), /Wrong assigned/)
  assert.throws(() => f.store.assign(first.id, 'wrong', 'helper'), /Stale/)
  f.advance(101); f.restart(); assert.equal(f.store.leaseNext({ maxRunning: 1 }), null)
  f.advance(5001); f.store.setPaused(true); assert.equal(f.store.leaseNext(), null); f.store.setPaused(false)
  const second = lease(f.store); assert.notEqual(second.leaseToken, first.leaseToken)
  assert.throws(() => finish(f.store, first, { decision: 'suppress', reason: 'late' }), /Stale/)
  f.store.fail(second.id, { leaseToken: second.leaseToken, error: 'Agent failed' })
  assert.equal(f.store.read().jobs[0].status, 'stalled'); f.store.retry(second.id)
  assert.equal(lease(f.store).attempt, 1)
})

test('comments delegate a deterministic task and return completion under the same thread after restart', t => {
  const f = setup(t); const p = publish(f.store); const c = f.store.addComment(p.id, { body: 'Make rivals more aggressive' })
  const initial = lease(f.store); const output = { action: 'delegate', body: 'I will ask the game pair.', task: { title: 'Aggressive rivals', description: 'Add aggressive rivals; verify a complete playable round.' } }
  finish(f.store, initial, output); finish(f.store, initial, output)
  f.restart(); const pending = f.store.pendingDelegations(); assert.equal(pending.length, 1); assert.equal(pending[0].taskId, `reply-${c.id}`)
  f.store.markDelegated(c.id, pending[0].taskId); assert.equal(f.store.pendingDelegations().length, 0)
  const result = { status: 'done', summary: 'Rivals now compete harder.', evidence: 'Played a full round.' }
  f.store.taskCompleted('game', pending[0].taskId, result); assert.equal(f.store.taskCompleted('game', pending[0].taskId, result), null)
  const followup = lease(f.store); assert.equal(followup.payload.comment.body, c.body); assert.deepEqual(followup.payload.result, result)
  finish(f.store, followup, { action: 'reply', body: 'Done: rivals now compete harder.' })
  const saved = f.store.read().comments[0]; assert.equal(saved.status, 'answered'); assert.equal(saved.replies.length, 2); assert.equal(saved.publicationId, p.id)
})

test('blocked delegated result produces honest reply and later completion produces another', t => {
  const { store } = setup(t); const p = publish(store); const c = store.addComment(p.id, { body: 'Improve game' })
  finish(store, lease(store), { action: 'delegate', body: 'Asking the pair', task: { title: 'Improve game', description: 'Verify improvement' } })
  const taskId = store.pendingDelegations()[0].taskId
  store.taskCompleted('game', taskId, { status: 'blocked', reason: 'Need fixture' })
  finish(store, lease(store), { action: 'reply', body: 'The pair needs a fixture.' })
  assert.equal(store.read().comments[0].status, 'awaiting-task')
  store.taskCompleted('game', taskId, { status: 'done', summary: 'Complete' })
  finish(store, lease(store), { action: 'reply', body: 'Now complete.' })
  assert.equal(store.read().comments.find(v => v.id === c.id).replies.length, 3)
})

test('shared wiki without owning CR can publish and reply but cannot delegate', t => {
  const { store } = setup(t); store.ingest(source(1, { projectId: 'shared-wiki', ownerSessionId: null }))
  finish(store, lease(store), { decision: 'publish', reason: 'Useful knowledge', candidate }); finish(store, lease(store), candidate)
  const p = store.read().publications[0]; store.addComment(p.id, { body: 'Please act' }); const j = lease(store)
  assert.throws(() => finish(store, j, { action: 'delegate', body: 'Acting', task: { title: 'Act', description: 'Do work' } }), /owning CR/)
  finish(store, j, { action: 'reply', body: 'This shared page has no owning CR yet.' })
})

test('failed delegation backs off, survives restart, stalls and retries without changing task identity', t => {
  const f = setup(t); const p = publish(f.store); const c = f.store.addComment(p.id, { body: 'Improve game' })
  finish(f.store, lease(f.store), { action: 'delegate', body: 'Asking the pair', task: { title: 'Improve game', description: 'Verify improvement' } })
  const taskId = f.store.pendingDelegations()[0].taskId
  f.store.failDelegation(c.id, 'Owner offline'); assert.equal(f.store.pendingDelegations().length, 0)
  f.restart(); assert.equal(f.store.read().comments[0].delegation.error, 'Owner offline')
  assert.equal(f.store.read().comments[0].status, 'awaiting-task')
  f.advance(5000); assert.equal(f.store.pendingDelegations()[0].taskId, taskId)
  f.store.failDelegation(c.id, 'Still offline'); f.advance(10000)
  f.store.failDelegation(c.id, 'Unavailable'); f.advance(100000)
  assert.equal(f.store.pendingDelegations().length, 0)
  assert.equal(f.store.read().comments[0].delegation.status, 'stalled')
  assert.equal(f.store.read().comments[0].delegation.attempts, 3)
  f.restart(); f.store.retryDelegation(c.id)
  assert.equal(f.store.pendingDelegations()[0].taskId, taskId)
  assert.equal(f.store.read().comments[0].delegation.attempts, 0)
  f.store.markDelegated(c.id, taskId)
  assert.equal(f.store.read().comments[0].delegation.error, null)
  assert.equal(f.store.pendingDelegations().length, 0)
  assert.throws(() => f.store.failDelegation(c.id, 'Late failure'), /not queued/)
  assert.throws(() => f.store.retryDelegation(c.id), /Only stalled/)
})

test('malformed durable state fails closed and prompt requires explicit authenticated completion', t => {
  const f = setup(t); f.store.ingest(source()); const j = lease(f.store)
  const prompt = buildProjectCommsPrompt(j, { callbackUrl: 'http://127.0.0.1/callback' })
  assert.match(prompt, /FEATHER_BRIDGE_TOKEN/)
  fs.writeFileSync(path.join(f.root, 'project-comms.json'), JSON.stringify({ version: 1, paused: false, sources: [], jobs: [{ id: 'bad' }], publications: [], comments: [] }))
  assert.throws(() => f.store.read())
})
