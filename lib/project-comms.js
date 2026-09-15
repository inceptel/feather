import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createJsonState, isJsonRecord } from './json-state.js'

const text = (v, max = 50000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const id = v => text(v, 200) && /^[A-Za-z0-9_-]+$/.test(v)
const owner = v => v === null || id(v)
const time = v => Number.isFinite(v) && v >= 0
const check = (ok, message, status = 400) => { if (!ok) throw Object.assign(new Error(message), { status }) }
const canonical = v => Array.isArray(v) ? v.map(canonical) : isJsonRecord(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const hash = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex')
export const projectCommsSourceKey = input => hash({ projectId: input.projectId, id: input.id, snapshot: input.snapshot })
const linksValid = links => links === undefined || (Array.isArray(links) && links.length <= 20 && links.every(l => isJsonRecord(l) && text(l.label, 300) && text(l.url, 3000) && /^https?:\/\//.test(l.url)))
const cardValid = c => isJsonRecord(c) && text(c.title, 300) && text(c.summary) && linksValid(c.links)
const candidateValid = c => cardValid(c) && text(c.evidence)
const taskValid = t => isJsonRecord(t) && text(t.title, 300) && text(t.description, 12000)
const delegationValid = d => isJsonRecord(d) && id(d.taskId) && taskValid(d.task) && typeof d.dispatched === 'boolean' && Number.isInteger(d.attempts) && d.attempts >= 0 && (d.error === null || text(d.error)) && time(d.nextAttemptAt) && ['queued', 'stalled', 'dispatched'].includes(d.status) && d.dispatched === (d.status === 'dispatched')
const roles = ['caretaker', 'marketer', 'replyguy']
const statuses = ['queued', 'running', 'done', 'stalled']
function payloadValid(j) {
  if (!isJsonRecord(j.payload) || !text(j.payload.projectTitle, 1000)) return false
  if (j.role === 'caretaker') return Array.isArray(j.payload.sources) && j.payload.sources.length > 0 && Array.isArray(j.payload.sourceKeys) && j.payload.sourceKeys.every(id)
  if (j.role === 'marketer') return id(j.payload.caretakerJobId) && candidateValid(j.payload.candidate) && Array.isArray(j.payload.sourceKeys) && j.payload.sourceKeys.every(id)
  return id(j.payload.commentId) && ['initial', 'followup'].includes(j.payload.phase) && isJsonRecord(j.payload.comment) && isJsonRecord(j.payload.publication) && (j.payload.phase !== 'followup' || isJsonRecord(j.payload.result))
}
function valid(doc) {
  if (!isJsonRecord(doc) || doc.version !== 1 || typeof doc.paused !== 'boolean' || !['sources', 'jobs', 'publications', 'comments'].every(k => Array.isArray(doc[k]))) return false
  if (!doc.sources.every(s => id(s.key) && text(s.id, 1000) && id(s.projectId) && text(s.projectTitle, 1000) && owner(s.ownerSessionId) && text(s.kind, 100) && isJsonRecord(s.snapshot) && time(s.createdAt))) return false
  if (!doc.jobs.every(j => id(j.id) && roles.includes(j.role) && statuses.includes(j.status) && id(j.projectId) && owner(j.ownerSessionId) && text(j.projectTitle, 1000) && isJsonRecord(j.payload) && Number.isInteger(j.attempt) && j.attempt >= 0 && time(j.createdAt) && time(j.updatedAt) && time(j.nextAttemptAt) && (j.assignedSessionId === null || id(j.assignedSessionId)) && (j.leaseToken === null || id(j.leaseToken)) && (j.leaseExpiresAt === null || time(j.leaseExpiresAt)) && (j.error === null || text(j.error)) && (j.status !== 'running' || (id(j.leaseToken) && time(j.leaseExpiresAt))))) return false
  if (!doc.publications.every(p => id(p.id) && id(p.projectId) && owner(p.ownerSessionId) && id(p.jobId) && text(p.projectTitle, 1000) && cardValid(p) && text(p.evidence) && time(p.createdAt) && Array.isArray(p.sourceKeys) && p.sourceKeys.every(id))) return false
  if (!doc.comments.every(c => id(c.id) && id(c.publicationId) && id(c.projectId) && owner(c.ownerSessionId) && text(c.body, 12000) && text(c.author, 300) && time(c.createdAt) && ['queued', 'awaiting-task', 'followup-queued', 'answered'].includes(c.status) && Array.isArray(c.replies) && c.replies.every(r => id(r.id) && id(r.jobId) && text(r.body) && time(r.createdAt)) && (c.delegation === null || delegationValid(c.delegation)))) return false
  if (!doc.jobs.every(payloadValid)) return false
  if (!doc.publications.every(p => doc.jobs.some(j => j.id === p.jobId && j.role === 'marketer' && j.status === 'done'))) return false
  if (!doc.comments.every(c => doc.publications.some(p => p.id === c.publicationId && p.projectId === c.projectId && p.ownerSessionId === c.ownerSessionId))) return false
  return ['sources', 'jobs', 'publications', 'comments'].every(k => new Set(doc[k].map(v => v.id + (k === 'sources' ? v.key : ''))).size === doc[k].length)
}

/** Synchronous single-process owner. Session authentication and dispatch belong to the runtime. */
export function createProjectComms({ root, now = Date.now, leaseMs = 20 * 60_000, maxAttempts = 3, coalesceMs = 30_000 }) {
  check(text(root), 'Communications root required')
  check(Number.isInteger(maxAttempts) && maxAttempts > 0 && leaseMs > 0 && coalesceMs >= 0, 'Invalid queue options')
  const state = createJsonState({ root, file: path.join(root, 'project-comms.json'), document: 'project communications', defaultValue: () => ({ version: 1, paused: false, sources: [], jobs: [], publications: [], comments: [] }), validate: valid, defaultMode: 0o600 })
  function mutate(fn) { let result; state.update(current => { const doc = structuredClone(current); result = fn(doc); check(['sources', 'jobs', 'publications', 'comments'].every(k => doc[k].length <= 20000) && JSON.stringify(doc).length <= 50_000_000, 'Communications capacity reached; archive required', 409); return doc }); return structuredClone(result) }
  function job(doc, role, source, payload, jobId = randomUUID()) {
    const existing = doc.jobs.find(j => j.id === jobId)
    if (existing) return existing
    const j = { id: jobId, role, projectId: source.projectId, projectTitle: payload.projectTitle, ownerSessionId: source.ownerSessionId, payload, status: 'queued', attempt: 0, createdAt: now(), updatedAt: now(), nextAttemptAt: now(), assignedSessionId: null, leaseToken: null, leaseExpiresAt: null, error: null }
    doc.jobs.push(j); return j
  }
  function findJob(doc, jobId) { const j = doc.jobs.find(j => j.id === jobId); check(j, 'Unknown communications job', 404); return j }
  function leased(j, token) { check(j.status === 'running' && j.leaseToken === token && j.leaseExpiresAt > now(), 'Stale job lease', 409) }
  function failJob(j, error) {
    j.status = j.attempt >= maxAttempts ? 'stalled' : 'queued'; j.error = String(error).slice(0, 50000) || 'Job failed'
    j.nextAttemptAt = now() + Math.min(300_000, 5000 * 2 ** Math.max(0, j.attempt - 1)); j.updatedAt = now()
    j.lastSessionId = j.assignedSessionId; j.leaseToken = null; j.assignedSessionId = null; j.leaseExpiresAt = null
  }
  return {
    read: () => state.read(),
    ingest(input) {
      check(isJsonRecord(input) && text(input.id, 1000) && id(input.projectId) && text(input.projectTitle, 1000) && owner(input.ownerSessionId) && text(input.kind, 100) && isJsonRecord(input.snapshot), 'Invalid source')
      check(JSON.stringify(input.snapshot).length <= 500000, 'Source snapshot too large')
      const key = projectCommsSourceKey(input)
      if (state.read().sources.some(s => s.key === key)) return { duplicate: true, key }
      return mutate(doc => {
        if (doc.sources.some(s => s.key === key)) return { duplicate: true, key }
        const source = { ...input, key, createdAt: now() }; doc.sources.push(source)
        let j = doc.jobs.find(j => j.role === 'caretaker' && j.projectId === input.projectId && j.status === 'queued' && j.attempt === 0 && j.payload.sources.length < 50 && JSON.stringify(j.payload).length + JSON.stringify(source).length < 250000)
        if (!j) j = job(doc, 'caretaker', source, { projectTitle: source.projectTitle, sources: [], sourceKeys: [], recentPublications: doc.publications.filter(p => p.projectId === source.projectId).slice(-10) })
        j.payload.sources.push(source); j.payload.sourceKeys.push(key); j.updatedAt = now(); j.nextAttemptAt = j.createdAt + coalesceMs
        return { duplicate: false, key, jobId: j.id }
      })
    },
    leaseNext({ maxRunning = 2 } = {}) {
      check(Number.isInteger(maxRunning) && maxRunning > 0, 'Invalid concurrency limit')
      const current = state.read()
      const expired = current.jobs.some(j => j.status === 'running' && j.leaseExpiresAt <= now())
      if (!expired && (current.paused || current.jobs.filter(j => j.status === 'running').length >= maxRunning || !current.jobs.some(j => j.status === 'queued' && j.nextAttemptAt <= now()))) return null
      return mutate(doc => {
        for (const j of doc.jobs) if (j.status === 'running' && j.leaseExpiresAt <= now()) failJob(j, 'Agent lease expired; no explicit completion received')
        if (doc.paused || doc.jobs.filter(j => j.status === 'running').length >= maxRunning) return null
        const activeProjects = new Set(doc.jobs.filter(j => j.status === 'running').map(j => j.projectId))
        const j = doc.jobs.find(j => j.status === 'queued' && j.nextAttemptAt <= now() && !activeProjects.has(j.projectId))
        if (!j) return null
        if (j.role === 'caretaker') j.payload.recentPublications = doc.publications.filter(p => p.projectId === j.projectId).slice(-10)
        j.status = 'running'; j.attempt++; j.leaseToken = randomUUID(); j.leaseExpiresAt = now() + leaseMs; j.assignedSessionId = null; j.updatedAt = now(); return j
      })
    },
    assign(jobId, token, sessionId) {
      check(id(sessionId), 'Invalid session ID')
      return mutate(doc => { const j = findJob(doc, jobId); leased(j, token); check(!j.assignedSessionId || j.assignedSessionId === sessionId, 'Job already assigned', 409); j.assignedSessionId = sessionId; return j })
    },
    complete(jobId, { leaseToken, sessionId, output }) {
      check(isJsonRecord(output), 'Invalid completion')
      return mutate(doc => {
        const j = findJob(doc, jobId)
        if (j.status === 'done' && j.leaseToken === leaseToken && j.assignedSessionId === sessionId && j.outputHash === hash(output)) return j
        leased(j, leaseToken); check(id(sessionId) && j.assignedSessionId === sessionId, 'Wrong assigned session', 403)
        if (j.role === 'caretaker') {
          check(['publish', 'suppress'].includes(output.decision) && text(output.reason), 'Caretaker decision and reason required')
          check(output.wikiPaths === undefined || (Array.isArray(output.wikiPaths) && output.wikiPaths.length <= 100 && output.wikiPaths.every(p => text(p, 4000) && path.isAbsolute(p))), 'Invalid edited wiki paths')
          if (output.decision === 'publish') {
            check(candidateValid(output.candidate), 'Caretaker candidate requires title, summary and evidence')
            job(doc, 'marketer', j, { projectTitle: j.payload.projectTitle, candidate: output.candidate, caretakerJobId: j.id, sourceKeys: j.payload.sourceKeys, sources: j.payload.sources }, `market-${j.id}`)
          }
        } else if (j.role === 'marketer') {
          check(cardValid(output), 'Marketer requires a title and summary')
          check((output.links ?? []).every(link => (j.payload.candidate.links ?? []).some(approved => approved.url === link.url)), 'Marketer links must come from the approved candidate')
          const caretaker = findJob(doc, j.payload.caretakerJobId)
          check(caretaker.status === 'done' && caretaker.output?.decision === 'publish', 'Caretaker approval required', 409)
          doc.publications.push({ id: `pub-${j.id}`, jobId: j.id, projectId: j.projectId, ownerSessionId: j.ownerSessionId, projectTitle: j.payload.projectTitle, title: output.title, summary: output.summary, links: output.links ?? [], evidence: j.payload.candidate.evidence, sourceKeys: j.payload.sourceKeys, createdAt: now() })
        } else {
          const c = doc.comments.find(c => c.id === j.payload.commentId); check(c, 'Unknown comment', 404)
          check(['reply', 'delegate'].includes(output.action) && text(output.body), 'Replyguy action and body required')
          if (output.action === 'delegate') {
            check(c.ownerSessionId !== null && !c.delegation && j.payload.phase !== 'followup' && taskValid(output.task), 'Only one valid delegation to an owning CR per comment is allowed', 409)
            c.delegation = { taskId: `reply-${c.id}`, task: output.task, dispatched: false, attempts: 0, error: null, nextAttemptAt: now(), status: 'queued' }; c.status = 'awaiting-task'
          } else if (j.payload.phase !== 'followup' || c.delegation?.lastResultHash === j.payload.resultHash) c.status = j.payload.result?.status === 'blocked' ? 'awaiting-task' : 'answered'
          c.replies.push({ id: `reply-${j.id}`, jobId: j.id, body: output.body, createdAt: now() })
        }
        j.status = 'done'; j.output = output; j.outputHash = hash(output); j.updatedAt = now(); j.error = null; return j
      })
    },
    fail(jobId, { leaseToken, error }) { return mutate(doc => { const j = findJob(doc, jobId); leased(j, leaseToken); failJob(j, error); return j }) },
    retry(jobId) { return mutate(doc => { const j = findJob(doc, jobId); check(j.status === 'stalled', 'Only stalled jobs can be retried', 409); j.status = 'queued'; j.attempt = 0; j.nextAttemptAt = now(); j.updatedAt = now(); return j }) },
    setPaused(paused) { check(typeof paused === 'boolean', 'Paused must be boolean'); return mutate(doc => { doc.paused = paused; return { paused } }) },
    addComment(publicationId, { body, author = 'You' }) {
      check(text(body, 12000) && text(author, 300), 'Invalid comment')
      return mutate(doc => {
        const p = doc.publications.find(p => p.id === publicationId); check(p, 'Unknown publication', 404)
        const c = { id: randomUUID(), publicationId, projectId: p.projectId, ownerSessionId: p.ownerSessionId, body, author, createdAt: now(), status: 'queued', replies: [], delegation: null }; doc.comments.push(c)
        job(doc, 'replyguy', p, { phase: 'initial', projectTitle: p.projectTitle, publication: p, commentId: c.id, comment: c, thread: doc.comments.filter(v => v.publicationId === publicationId) }, `comment-${c.id}`)
        return c
      })
    },
    pendingDelegations() { return state.read().comments.filter(c => c.delegation?.status === 'queued' && c.delegation.nextAttemptAt <= now()).map(c => ({ commentId: c.id, projectId: c.projectId, ownerSessionId: c.ownerSessionId, taskId: c.delegation.taskId, task: c.delegation.task })) },
    failDelegation(commentId, error) {
      return mutate(doc => {
        const c = doc.comments.find(c => c.id === commentId)
        check(c?.delegation?.status === 'queued', 'Delegation is not queued', 409)
        const d = c.delegation
        d.attempts++; d.error = String(error).slice(0, 50000) || 'Delegation failed'
        d.status = d.attempts >= maxAttempts ? 'stalled' : 'queued'
        d.nextAttemptAt = now() + Math.min(300_000, 5000 * 2 ** Math.max(0, d.attempts - 1))
        return c
      })
    },
    retryDelegation(commentId) {
      return mutate(doc => {
        const c = doc.comments.find(c => c.id === commentId)
        check(c?.delegation?.status === 'stalled', 'Only stalled delegations can be retried', 409)
        Object.assign(c.delegation, { attempts: 0, error: null, status: 'queued', nextAttemptAt: now() })
        return c
      })
    },
    markDelegated(commentId, taskId) { return mutate(doc => { const c = doc.comments.find(c => c.id === commentId); check(c?.delegation?.taskId === taskId, 'Delegation mismatch', 409); c.delegation.dispatched = true; c.delegation.status = 'dispatched'; c.delegation.error = null; return c }) },
    taskCompleted(projectId, taskId, result) {
      check(id(projectId) && id(taskId) && isJsonRecord(result), 'Invalid task result')
      const resultHash = hash(result)
      const current = state.read().comments.find(c => c.projectId === projectId && c.delegation?.taskId === taskId)
      if (!current || current.delegation.lastResultHash === resultHash) return null
      return mutate(doc => {
        const c = doc.comments.find(c => c.projectId === projectId && c.delegation?.taskId === taskId)
        if (!c || c.delegation.lastResultHash === resultHash) return null
        const p = doc.publications.find(p => p.id === c.publicationId)
        c.delegation.dispatched = true; c.delegation.status = 'dispatched'; c.delegation.error = null; c.delegation.result = result; c.delegation.lastResultHash = resultHash; c.status = 'followup-queued'
        return job(doc, 'replyguy', c, { phase: 'followup', projectTitle: p.projectTitle, publication: p, commentId: c.id, comment: c, taskId, result, resultHash, thread: doc.comments.filter(v => v.publicationId === p.id) }, `followup-${c.id}-${resultHash}`)
      })
    },
  }
}
