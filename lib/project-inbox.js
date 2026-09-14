import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createJsonState, isJsonRecord } from './json-state.js'

const statuses = ['queued', 'agreeing', 'building', 'reviewing', 'approved', 'done', 'blocked']
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const str = (value, max = 12000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const requireThat = (condition, message, status = 400) => { if (!condition) throw Object.assign(new Error(message), { status }) }
const criteriaValid = value => Array.isArray(value) && value.length <= 100 && value.every(item => str(item, 2000))
const resultValid = value => isJsonRecord(value) && str(value.summary) && str(value.evidence) && (value.wiki === undefined || str(value.wiki))
const configValid = value => isJsonRecord(value) && str(value.objective) && typeof value.allowIdeas === 'boolean' && (value.maxGeneratedTasks === undefined || (Number.isInteger(value.maxGeneratedTasks) && value.maxGeneratedTasks >= 0))
function validTask(task, ids) {
  if (!isJsonRecord(task) || !id(task.id) || !str(task.title, 300) || !str(task.description) || !['human', 'agent'].includes(task.source) || !statuses.includes(task.status)) return false
  if (task.owner !== null && !id(task.owner)) return false
  if (!criteriaValid(task.criteria) || !Array.isArray(task.dependsOn) || !task.dependsOn.every(dep => id(dep) && dep !== task.id && ids.has(dep))) return false
  if (task.revision !== null && !str(task.revision, 1000)) return false
  if (task.review !== null && !(isJsonRecord(task.review) && ['PASS', 'REVISE'].includes(task.review.verdict) && str(task.review.evidence) && str(task.review.revision, 1000))) return false
  if (task.result !== null && !resultValid(task.result)) return false
  if (!Array.isArray(task.history) || task.history.length > 1000 || !task.history.every(event => isJsonRecord(event) && str(event.at, 100) && id(event.sessionId) && str(event.action, 100))) return false
  if (task.status === 'queued' ? task.owner !== null : !id(task.owner)) return false
  if (['building', 'reviewing', 'approved', 'done'].includes(task.status) && !task.criteria.length) return false
  if (['reviewing', 'approved', 'done'].includes(task.status) && !str(task.revision, 1000)) return false
  if (['approved', 'done'].includes(task.status) && !(task.review?.verdict === 'PASS' && task.review.revision === task.revision)) return false
  return task.status !== 'done' || resultValid(task.result)
}
function validDocument(doc) {
  if (!isJsonRecord(doc) || doc.version !== 1 || !id(doc.projectId) || !Array.isArray(doc.tasks) || doc.tasks.length > 1000) return false
  if (doc.config !== null && !configValid(doc.config)) return false
  const ids = new Set(doc.tasks.map(task => task?.id))
  if (ids.size !== doc.tasks.length || !doc.tasks.every(task => validTask(task, ids))) return false
  const activeOwners = doc.tasks.filter(task => task.owner !== null && task.status !== 'done').map(task => task.owner)
  return new Set(activeOwners).size === activeOwners.length
}
function checkActor(actor, role) {
  requireThat(isJsonRecord(actor) && id(actor.sessionId) && ['human', 'creator', 'reviewer'].includes(actor.role), 'Invalid actor')
  if (role) requireThat(actor.role === role, `${role} role required`, 403)
  if (actor.role !== 'human') requireThat(id(actor.creatorSessionId) && (actor.role !== 'creator' || actor.sessionId === actor.creatorSessionId) && (actor.role !== 'reviewer' || actor.sessionId !== actor.creatorSessionId), 'Invalid pair identity', 403)
}
function event(task, actor, action, details = {}) {
  task.history.push({ at: new Date().toISOString(), sessionId: actor.sessionId, action, ...details })
  task.history = task.history.slice(-1000)
}

/** One synchronous Feather process owns mutations; callers authenticate actor identities. */
export function createProjectInbox({ root }) {
  requireThat(str(root), 'Inbox root required')
  function state(projectId) {
    requireThat(id(projectId), 'Invalid project ID')
    return createJsonState({ root, file: path.join(root, `${projectId}.json`), document: 'project inbox', defaultValue: () => ({ version: 1, projectId, config: null, tasks: [] }), validate: doc => validDocument(doc) && doc.projectId === projectId })
  }
  function mutate(projectId, operation) {
    let answer
    state(projectId).update(current => {
      const doc = structuredClone(current)
      answer = operation(doc)
      return doc
    })
    return structuredClone(answer)
  }
  function configured(doc) { requireThat(doc.config !== null, 'Project inbox is not configured', 409) }
  return {
    read(projectId) { return state(projectId).read() },
    configure(projectId, options, actor) {
      checkActor(actor, 'human')
      requireThat(configValid(options), 'Invalid project configuration')
      return mutate(projectId, doc => { doc.config = { objective: options.objective, allowIdeas: options.allowIdeas, ...(options.maxGeneratedTasks === undefined ? {} : { maxGeneratedTasks: options.maxGeneratedTasks }) }; return doc })
    },
    add(projectId, input, actor) {
      checkActor(actor)
      requireThat(actor.role !== 'reviewer', 'Reviewers cannot add tasks', 403)
      requireThat(isJsonRecord(input) && str(input.title, 300) && (input.description === undefined || str(input.description)) && (input.id === undefined || id(input.id)) && (input.dependsOn === undefined || (Array.isArray(input.dependsOn) && input.dependsOn.every(id))), 'Invalid task')
      const description = input.description ?? input.title
      return mutate(projectId, doc => {
        configured(doc)
        const taskId = input.id ?? randomUUID()
        const source = actor.role === 'human' ? 'human' : 'agent'
        const deps = [...new Set(input.dependsOn ?? [])]
        const existing = doc.tasks.find(task => task.id === taskId)
        if (existing) {
          requireThat(existing.title === input.title && existing.description === description && existing.source === source && JSON.stringify(existing.dependsOn) === JSON.stringify(deps), 'Task ID already has different content', 409)
          return existing
        }
        requireThat(source === 'human' || (doc.config.allowIdeas && (doc.config.maxGeneratedTasks === undefined || doc.tasks.filter(task => task.source === 'agent').length < doc.config.maxGeneratedTasks)), 'Agent ideas are disabled or quota exhausted', 409)
        requireThat(doc.tasks.length < 1000, 'Project task limit reached', 409)
        requireThat(deps.every(dep => dep !== taskId && doc.tasks.some(task => task.id === dep)), 'Invalid task dependency')
        const task = { id: taskId, title: input.title, description, source, dependsOn: deps, owner: null, status: 'queued', criteria: [], revision: null, review: null, result: null, history: [] }
        event(task, actor, 'add'); doc.tasks.push(task); return task
      })
    },
    claim(projectId, actor, options = {}) {
      checkActor(actor, 'creator')
      requireThat(isJsonRecord(options) && (options.taskId === undefined || id(options.taskId)), 'Invalid claim')
      return mutate(projectId, doc => {
        configured(doc)
        const owned = doc.tasks.find(task => task.owner === actor.creatorSessionId && task.status !== 'done')
        if (options.taskId) requireThat(doc.tasks.some(task => task.id === options.taskId), 'Unknown task', 404)
        if (owned) { requireThat(!options.taskId || options.taskId === owned.id, 'Pair already owns unfinished task', 409); return owned }
        const completedIds = new Set(doc.tasks.filter(task => task.status === 'done').map(task => task.id))
        const task = doc.tasks.find(task => task.status === 'queued' && (!options.taskId || task.id === options.taskId) && task.dependsOn.every(dep => completedIds.has(dep)))
        if (!task) return null
        task.owner = actor.creatorSessionId; task.status = 'agreeing'; event(task, actor, 'claim'); return task
      })
    },
    transition(projectId, taskId, action, input = {}, actor) {
      checkActor(actor)
      requireThat(id(taskId) && isJsonRecord(input), 'Invalid transition')
      return mutate(projectId, doc => {
        configured(doc)
        const task = doc.tasks.find(item => item.id === taskId)
        requireThat(task, 'Unknown task', 404)
        requireThat((action === 'unblock' && actor.role === 'human') || (actor.role !== 'human' && task.owner === actor.creatorSessionId), 'Wrong task owner', 403)
        if (action === 'propose') {
          checkActor(actor, 'creator'); requireThat(criteriaValid(input.criteria) && input.criteria.length > 0, 'Propose requires nonempty criteria')
          requireThat(task.status === 'agreeing', 'Propose requires agreeing task', 409)
          task.criteria = [...input.criteria]; task.review = null
        } else if (action === 'agree') {
          checkActor(actor, 'reviewer')
          if (task.status === 'building' && task.history.at(-1)?.action === 'agree' && task.history.at(-1)?.sessionId === actor.sessionId) return task
          requireThat(task.status === 'agreeing' && task.criteria.length > 0, 'Agreement requires proposed criteria', 409)
          task.status = 'building'
        } else if (action === 'submit') {
          checkActor(actor, 'creator'); requireThat(str(input.revision, 1000), 'Submit requires revision')
          if (['reviewing', 'approved'].includes(task.status) && input.revision === task.revision) return task
          requireThat(['building', 'approved'].includes(task.status) && input.revision !== task.revision, 'Submit requires a new revision while building or approved', 409)
          task.revision = input.revision; task.review = null; task.status = 'reviewing'
        } else if (action === 'review') {
          checkActor(actor, 'reviewer'); requireThat(str(input.revision, 1000) && ['PASS', 'REVISE'].includes(input.verdict) && str(input.evidence), 'Review requires revision, verdict, and evidence')
          if (['approved', 'building'].includes(task.status) && task.review?.revision === input.revision && task.review.verdict === input.verdict && task.review.evidence === input.evidence && task.history.at(-1)?.sessionId === actor.sessionId) return task
          requireThat(task.status === 'reviewing' && input.revision === task.revision, 'Review requires current revision', 409)
          task.review = { revision: input.revision, verdict: input.verdict, evidence: input.evidence }; task.status = input.verdict === 'PASS' ? 'approved' : 'building'
        } else if (action === 'complete') {
          checkActor(actor, 'creator'); requireThat(str(input.revision, 1000) && resultValid(input.result), 'Completion requires revision and result evidence')
          requireThat(['approved', 'done'].includes(task.status) && input.revision === task.revision, 'Completion requires approved revision', 409)
          if (task.status === 'done') { requireThat(task.result.summary === input.result.summary && task.result.evidence === input.result.evidence && task.result.wiki === input.result.wiki, 'Completed result cannot change', 409); return task }
          task.result = { summary: input.result.summary, evidence: input.result.evidence, ...(input.result.wiki === undefined ? {} : { wiki: input.result.wiki }) }; task.status = 'done'
        } else if (action === 'block') {
          checkActor(actor, 'creator'); requireThat(str(input.reason), 'Block requires a reason'); requireThat(!['queued', 'done', 'blocked'].includes(task.status), 'Block requires active work', 409); task.status = 'blocked'
        } else if (action === 'unblock') {
          requireThat(['human', 'creator'].includes(actor.role), 'Only human or creator may unblock', 403); requireThat(task.status === 'blocked', 'Unblock requires blocked task', 409); task.status = 'agreeing'; task.review = null; task.revision = null; task.criteria = []
        } else requireThat(false, 'Unknown transition action')
        event(task, actor, action, { ...(input.revision ? { revision: input.revision } : {}), ...(input.reason ? { reason: input.reason } : {}), ...(action === 'propose' ? { criteria: task.criteria } : {}), ...(action === 'review' ? { verdict: input.verdict, evidence: input.evidence } : {}) })
        return task
      })
    },
  }
}
