import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as settle } from 'node:timers/promises'
import { createProjectComms } from '../../lib/project-comms.js'
import { createProjectInbox } from '../../lib/project-inbox.js'
import { applyChatWorkflow, authorizeChatWorkflow } from '../../lib/chat-workflow.js'
import { createProjectCommsRuntime, projectCommsSources, projectCommsFeed, projectCommsComment } from '../../lib/project-comms-runtime.js'

const creator = { role: 'creator', sessionId: 'creator', creatorSessionId: 'creator' }
const reviewer = { role: 'reviewer', sessionId: 'reviewer', creatorSessionId: 'creator' }
const human = { role: 'human', sessionId: 'creator' }
const candidate = { title: 'Smarter rivals', summary: 'Inventory now changes rival behavior.', evidence: 'Independent reviewer played a full round.', links: [{ label: 'Play', url: 'https://example.com/play' }] }

test('unused and retired pair evidence is never collected for publication', t => {
  const f = fixture(t)
  f.meta.creator.workflow = { checkpoints: [{ id: 'setup', publish: true, summary: 'Setup output', evidence: 'Setup file' }] }
  for (const chatStandby of [true, 'retired']) {
    f.meta.creator.chatStandby = chatStandby
    assert.deepEqual(projectCommsSources(f.meta, f.inbox, f.wikiPath), [])
  }
  f.meta.creator.chatStandby = false
  assert.equal(projectCommsSources(f.meta, f.inbox, f.wikiPath).length, 1)
})

test('interim workflow evidence reaches editors before completion, survives restart and may be suppressed', async t => {
  const f = fixture(t)
  let workflow = authorizeChatWorkflow(undefined, 1000000)
  workflow = applyChatWorkflow(workflow, { action: 'start', generation: 1, objective: 'Improve rivals' }, { role: 'creator', now: 1000000 }).workflow
  workflow = applyChatWorkflow(workflow, { action: 'progress', generation: 1, summary: 'A prototype responds to inventory', evidence: 'Prototype played locally; independent review remains pending', publish: true }, { role: 'creator', now: 1000000 }).workflow
  f.meta.creator.workflow = workflow
  const sources = projectCommsSources(f.meta, f.inbox, f.wikiPath)
  assert.equal(sources.length, 1)
  assert.equal(sources[0].snapshot.reviewed, false)
  assert.equal(sources[0].snapshot.provenance, 'creator-progress')
  await f.tick()
  assert.match(f.launches[0].prompt, /interim observations, not reviewed completion/)
  await f.complete('caretaker', { decision: 'suppress', reason: 'Wait for stronger evidence', wikiPaths: [] })
  f.restart(); await f.tick()
  assert.equal(f.launches.length, 1)
  assert.deepEqual(projectCommsFeed(f.store), [])
  assert.equal(f.meta.creator.workflow.summary, 'A prototype responds to inventory')
})

test('material progress publishes through caretaker and marketer while its objective remains active', async t => {
  const f = fixture(t)
  let workflow = authorizeChatWorkflow(undefined, 1000000)
  workflow = applyChatWorkflow(workflow, { action: 'start', generation: 1, objective: 'Improve rivals' }, { role: 'creator', now: 1000000 }).workflow
  f.meta.creator.workflow = applyChatWorkflow(workflow, { action: 'progress', generation: 1,
    summary: 'Inventory response prototype is playable', evidence: 'A local game demonstrated responses; balancing remains', publish: true,
  }, { role: 'creator', now: 1000000 }).workflow
  await f.tick()
  await f.complete('caretaker', { decision: 'publish', reason: 'A useful interim result', wikiPaths: [],
    candidate: { title: 'A playable first step', summary: 'The prototype responds to inventory. Balancing is still underway.', evidence: 'Local game observation', links: [] },
  })
  await f.complete('marketer', { title: 'A playable first step', summary: 'The prototype responds to inventory. Balancing is still underway.', links: [] })
  assert.equal(f.store.read().publications.length, 1)
  assert.equal(f.meta.creator.workflow.enabled, true)
  assert.equal(f.inbox.read('example-game').tasks.length, 0)
  f.restart(); await f.tick()
  assert.equal(f.store.read().publications.length, 1)
})

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-comms-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const projectPath = path.join(root, 'example-game'), wikiPath = path.join(root, 'wiki')
  fs.mkdirSync(projectPath); fs.mkdirSync(wikiPath)
  const wiki = path.join(wikiPath, 'example-game.md')
  const meta = { creator: { chatRole: 'creator', chatProjectId: 'example-game', title: 'Example Game', cwd: projectPath }, reviewer: { chatRole: 'reviewer', chatProjectId: 'example-game', cwd: projectPath } }
  let now = 1_000_000, failLaunch = false, failSend = false
  const launches = [], sends = []
  const inbox = createProjectInbox({ root: path.join(root, 'inboxes') })
  inbox.configure('example-game', { objective: 'Make the game fun.', allowIdeas: false }, human)
  const makeStore = () => createProjectComms({ root, now: () => now, coalesceMs: 0, ...options })
  let store = makeStore()
  const makeRuntime = (readOnly = false) => createProjectCommsRuntime({ store, root, wikiPath, readMeta: () => meta, inbox, baseUrl: 'http://localhost:3300', readOnly,
    launch: async input => { launches.push(input); if (failLaunch) { failLaunch = false; throw new Error('Transport unavailable') } },
    sendTask: async input => { sends.push(input); if (failSend) { failSend = false; throw new Error('Creator unavailable') } },
  })
  let runtime = makeRuntime()
  function finish(taskId, result = { summary: 'Rivals adapt to inventory.', evidence: 'Browser round and independent review pass.', wiki }) {
    inbox.claim('example-game', creator, { taskId })
    inbox.transition('example-game', taskId, 'propose', { criteria: ['A reviewer can play the changed behavior.'] }, creator)
    inbox.transition('example-game', taskId, 'agree', {}, reviewer)
    inbox.transition('example-game', taskId, 'submit', { revision: `rev-${taskId}` }, creator)
    inbox.transition('example-game', taskId, 'review', { revision: `rev-${taskId}`, verdict: 'PASS', evidence: 'Played and verified.' }, reviewer)
    inbox.transition('example-game', taskId, 'complete', { revision: `rev-${taskId}`, result }, creator)
  }
  function seed() {
    fs.writeFileSync(wiki, '# Example Game\nRivals use inventory pressure.\n')
    inbox.add('example-game', { id: 'rivals', title: 'Improve rivals' }, human)
    finish('rivals')
  }
  async function tick() { await settle(); await runtime.tick(); await settle() }
  function running(role, phase) { return store.read().jobs.find(job => job.role === role && job.status === 'running' && (!phase || job.payload.phase === phase)) }
  async function complete(role, output, phase) {
    await tick()
    const job = running(role, phase)
    assert.ok(job, `Expected running ${role} ${phase || ''}`)
    runtime.complete(job.id, job.assignedSessionId, { leaseToken: job.leaseToken, output })
    await tick()
    return job
  }
  async function publish() {
    seed(); await tick()
    await complete('caretaker', { decision: 'publish', reason: 'Players will notice this.', candidate, wikiPaths: [wiki] })
    await complete('marketer', { title: 'Your rivals play smarter', summary: 'Try another round: opponents now react to inventory.', links: [{ label: 'Play', url: 'https://example.com/play' }] })
    return store.read().publications[0]
  }
  return { root, wikiPath, wiki, meta, projectPath, inbox, launches, sends, finish, seed, tick, complete, publish, running,
    get store() { return store }, get runtime() { return runtime },
    restart: () => { store = makeStore(); runtime = makeRuntime() },
    readOnlyRuntime: () => makeRuntime(true), advance: ms => { now += ms }, failLaunch: () => { failLaunch = true }, failSend: () => { failSend = true },
  }
}

test('real project results and wiki evidence become an edited card only after both helper callbacks', async t => {
  const f = fixture(t); f.seed()
  fs.writeFileSync(path.join(f.projectPath, 'updates.creator.json'), JSON.stringify([{ id: 'note-one', summary: 'Rival logic changed.' }]))
  const sources = projectCommsSources(f.meta, f.inbox, f.wikiPath)
  assert.deepEqual(sources.map(source => source.kind).sort(), ['chat', 'task', 'wiki'])
  assert.ok(sources.every(source => source.projectId === 'example-game' && source.ownerSessionId === 'creator'))
  await f.tick()
  assert.equal(f.launches.length, 1)
  assert.equal(f.launches[0].role, 'caretaker')
  assert.match(f.launches[0].prompt, /Smarter|rivals|Rivals/)
  assert.deepEqual(projectCommsFeed(f.store), [])
  const caretaker = f.running('caretaker')
  assert.throws(() => f.runtime.complete(caretaker.id, 'imposter', { leaseToken: caretaker.leaseToken, output: { decision: 'suppress', reason: 'No news' } }), /Wrong assigned session/)
  fs.appendFileSync(f.wiki, '\nReviewed evidence is saved here.\n')
  await f.complete('caretaker', { decision: 'publish', reason: 'A useful gameplay change.', candidate, wikiPaths: [f.wiki] })
  assert.deepEqual(projectCommsFeed(f.store), [])
  const output = { title: 'Your rivals play smarter', summary: 'A new reason to play.', links: [{ label: 'Play now', url: 'https://example.com/play' }] }
  const marketer = await f.complete('marketer', output)
  f.runtime.complete(marketer.id, marketer.assignedSessionId, { leaseToken: marketer.leaseToken, output })
  await f.tick()
  f.restart(); await f.tick()
  const feed = projectCommsFeed(f.store)
  assert.equal(feed.length, 1)
  assert.equal(feed[0].sourceKind, 'project')
  assert.equal(feed[0].room, 'Example Game')
  assert.equal(feed[0].sessionId, 'creator')
  assert.match(feed[0].summary, /\[Play now\]\(https:\/\/example.com\/play\)/)
  assert.equal(f.store.read().jobs.length, 2, 'Caretaker wiki edits must not create a feedback loop')
  assert.equal(f.launches.length, 2, 'Restart and duplicate callbacks do not relaunch finished jobs')
})

test('comment delegates one durable task and reviewed completion returns under the same update after restart', async t => {
  const f = fixture(t), publication = await f.publish()
  const comment = f.store.addComment(publication.id, { body: 'Make opponents more aggressive.' })
  assert.equal(projectCommsComment(comment).reply, null)
  await f.tick()
  await f.complete('replyguy', { action: 'delegate', body: 'I have asked your team to increase aggression.', task: { title: 'More aggressive opponents', description: 'Adjust rival aggression and independently verify a round.' } }, 'initial')
  const taskId = `reply-${comment.id}`
  assert.equal(f.inbox.read('example-game').tasks.filter(task => task.id === taskId).length, 1)
  assert.equal(f.sends.length, 1)
  f.restart(); await f.tick(); await f.tick()
  assert.equal(f.sends.length, 1, 'Acknowledged delegation is not sent again on restart')
  assert.equal(f.inbox.read('example-game').tasks.filter(task => task.id === taskId).length, 1)
  f.finish(taskId, { summary: 'More aggressive opponents are live.', evidence: 'Reviewer played three rounds.', wiki: f.wiki })
  await f.tick(); await f.tick()
  // Per-project serialization lets caretaker evaluate the new CR result first.
  await f.complete('caretaker', { decision: 'suppress', reason: 'This result belongs in the existing comment thread.', wikiPaths: [] })
  await f.complete('replyguy', { action: 'reply', body: 'Done: opponents now quote more aggressively, and your reviewer verified three rounds.' }, 'followup')
  f.restart(); await f.tick()
  const card = projectCommsFeed(f.store).find(item => item.evidenceId === `project-update:${publication.id}`)
  assert.equal(card.comments.length, 1)
  assert.equal(card.comments[0].id, comment.id)
  assert.equal(card.comments[0].status, 'answered')
  assert.equal(card.comments[0].taskId, taskId)
  assert.match(card.comments[0].reply.text, /Done: opponents/)
  assert.equal(f.store.read().jobs.filter(job => job.role === 'replyguy' && job.payload.phase === 'followup').length, 1)
  assert.equal(f.store.read().publications.length, 1)
})

test('paused and read-only runtimes do not launch work; public status omits leases and prompts', async t => {
  const f = fixture(t); f.seed(); f.store.setPaused(true)
  await f.tick(); assert.equal(f.launches.length, 0)
  assert.equal(f.runtime.status().enabled, false)
  f.store.setPaused(false)
  await f.readOnlyRuntime().tick(); assert.equal(f.launches.length, 0)
  assert.throws(() => f.readOnlyRuntime().complete('anything', 'creator', {}), /Read-only/)
  await f.tick()
  const job = f.running('caretaker'), publicState = JSON.stringify(f.runtime.status())
  assert.equal(f.runtime.status().jobs[0].sessionId, job.assignedSessionId)
  assert.ok(!publicState.includes(job.leaseToken))
  assert.ok(!publicState.includes('payload') && !publicState.includes('leaseExpiresAt') && !publicState.includes('prompt'))
})

test('failed launch survives restart and retries with a new capability after backoff', async t => {
  const f = fixture(t); f.seed(); f.failLaunch(); await f.tick()
  const failed = f.store.read().jobs[0]
  assert.equal(failed.status, 'queued')
  assert.equal(failed.error, 'Transport unavailable')
  assert.equal(failed.leaseToken, null)
  assert.equal(failed.assignedSessionId, null)
  f.restart(); await f.tick(); assert.equal(f.launches.length, 1)
  f.advance(5001); await f.tick()
  assert.equal(f.launches.length, 2)
  assert.notEqual(f.launches[0].id, f.launches[1].id)
  assert.equal(f.running('caretaker').attempt, 2)
  assert.equal(f.store.read().jobs.length, 1)
})

test('failed task transport retries the existing inbox task instead of duplicating it', async t => {
  const f = fixture(t), publication = await f.publish()
  const comment = f.store.addComment(publication.id, { body: 'Improve the instructions.' })
  await f.tick(); f.failSend()
  const job = f.running('replyguy', 'initial')
  f.runtime.complete(job.id, job.assignedSessionId, { leaseToken: job.leaseToken, output: { action: 'delegate', body: 'I will bring this to your team.', task: { title: 'Improve instructions', description: 'Clarify how to quote and verify it.' } } })
  await settle()
  assert.equal(f.inbox.read('example-game').tasks.filter(task => task.id === `reply-${comment.id}`).length, 1)
  assert.equal(f.store.read().comments.find(item => item.id === comment.id).delegation.error, 'Creator unavailable')
  assert.equal(f.store.pendingDelegations().length, 0, 'Failed transport observes retry backoff')
  f.restart(); f.advance(5001); await f.tick()
  assert.equal(f.sends.length, 2, 'Unacknowledged external transport is retried (at-least-once)')
  assert.equal(f.inbox.read('example-game').tasks.filter(task => task.id === `reply-${comment.id}`).length, 1)
  assert.equal(f.store.pendingDelegations().length, 0)
})

test('duplicate caretaker callback does not acknowledge a later external wiki edit', async t => {
  const f = fixture(t); f.seed(); await f.tick()
  const output = { decision: 'suppress', reason: 'Wiki maintenance only.', wikiPaths: [f.wiki] }
  const job = await f.complete('caretaker', output)
  fs.appendFileSync(f.wiki, '\nA genuinely new human finding.\n')
  f.runtime.complete(job.id, job.assignedSessionId, { leaseToken: job.leaseToken, output })
  await f.tick()
  assert.equal(f.store.read().sources.filter(source => source.kind === 'wiki').length, 2)
  assert.equal(f.store.read().jobs.filter(job => job.role === 'caretaker').length, 2)
})

test('bad source is reported without stopping valid work and remains visible after restart', async t => {
  const f = fixture(t); f.seed()
  fs.writeFileSync(path.join(f.projectPath, 'updates.creator.json'), JSON.stringify([{ id: 'oversized', summary: 'x'.repeat(600000) }]))
  await f.tick()
  assert.equal(f.launches.length, 1, 'Valid task and wiki sources still dispatch')
  assert.match(f.runtime.status().error, /oversized.*Source snapshot too large/)
  assert.equal(f.store.read().sources.some(source => source.kind === 'chat'), false)
  f.restart(); await f.tick(); assert.match(f.runtime.status().error, /oversized/)
  fs.writeFileSync(path.join(f.projectPath, 'updates.creator.json'), '[]')
  await f.tick(); assert.equal(f.runtime.status().error, null)
})

test('public status keeps old unfinished jobs while bounding completed history', t => {
  const f = fixture(t)
  const jobs = [{ id: 'old-stalled', status: 'stalled', updatedAt: 1 }, ...Array.from({ length: 120 }, (_, index) => ({ id: `done-${index}`, status: 'done', updatedAt: index + 2 }))]
  const runtime = createProjectCommsRuntime({ store: { read: () => ({ paused: false, comments: [], publications: [], jobs }) }, root: f.root, wikiPath: f.wikiPath })
  const status = runtime.status()
  assert.equal(status.jobs.length, 101)
  assert.equal(status.jobs.find(job => job.id === 'old-stalled').status, 'stalled')
  assert.equal(status.jobs.some(job => job.id === 'done-0'), false)
})

test('pause during a delegation prevents the next delegation and helper launch', async t => {
  const f = fixture(t), p = await f.publish()
  f.store.setPaused(true)
  for (const body of ['First request', 'Second request']) {
    f.store.addComment(p.id, { body })
    f.store.setPaused(false)
    const job = f.store.leaseNext(); f.store.assign(job.id, job.leaseToken, 'helper')
    f.store.complete(job.id, { leaseToken: job.leaseToken, sessionId: 'helper', output: { action: 'delegate', body: 'Asking your team', task: { title: body, description: body } } })
    f.store.setPaused(true)
  }
  f.store.ingest({ id: 'more-work', projectId: 'another', projectTitle: 'Another project', ownerSessionId: 'creator', kind: 'task', snapshot: { summary: 'New result' } })
  let sends = 0, launches = 0
  const runtime = createProjectCommsRuntime({ store: f.store, root: f.root, wikiPath: f.wikiPath, readMeta: () => f.meta, inbox: f.inbox, baseUrl: 'http://localhost',
    sendTask: async () => { sends++; await settle(); f.store.setPaused(true) }, launch: async () => { launches++ },
  })
  f.store.setPaused(false); await runtime.tick()
  assert.equal(sends, 1); assert.equal(launches, 0)
  assert.equal(f.store.pendingDelegations().length, 1)
})
