import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createJsonState, isJsonRecord } from './json-state.js'
import { buildProjectCommsPrompt } from './project-comms-prompts.js'
import { commitWikiChanges } from './wiki-git.js'
import { projectCommsSourceKey } from './project-comms.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const inside = (root, file) => file === root || file.startsWith(root + path.sep)

// Sources are evidence, never directly published copy. Stable project/session
// IDs survive display-name changes and do not rely on legacy Room slugs.
export function projectCommsSources(meta, inbox, wikiPath) {
  const sources = [], projects = new Map(), wikiOwners = new Map()
  for (const [sessionId, chat] of Object.entries(meta)) {
    if (chat.chatStandby || chat.chatRole !== 'creator' || !chat.chatProjectId || !chat.cwd) continue
    const project = { projectId: chat.chatProjectId, projectTitle: chat.title || 'Project', ownerSessionId: sessionId, projectPath: chat.cwd }
    for (const checkpoint of chat.workflow?.checkpoints || []) {
      if (!checkpoint.publish || !checkpoint.id || !checkpoint.summary || !checkpoint.evidence) continue
      sources.push({ ...project, id: `progress:${sessionId}:${checkpoint.id}`, kind: 'chat', snapshot: {
        ...checkpoint, projectPath: chat.cwd,
        provenance: 'creator-progress', reviewed: false,
      } })
    }
    if (!projects.has(project.projectId)) {
      projects.set(project.projectId, project)
      const doc = inbox.read(project.projectId)
      for (const task of doc.tasks) {
        if (task.result?.wiki) wikiOwners.set(path.resolve(task.result.wiki), { ...project, ownerSessionId: task.owner || sessionId })
        if (task.status !== 'done' || !task.result) continue
        sources.push({ ...project, ownerSessionId: task.owner || sessionId, id: `task:${project.projectId}:${task.id}`, kind: 'task', snapshot: {
          taskId: task.id, title: task.title, result: task.result, review: task.review,
          objective: doc.config?.objective || '', projectPath: chat.cwd,
        } })
      }
    }
    const file = path.join(chat.cwd, `updates.${sessionId}.json`)
    try {
      if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) continue
      const updates = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(updates)) continue
      for (const update of updates.slice(-200)) {
        if (!update || typeof update.id !== 'string' || typeof update.summary !== 'string') continue
        sources.push({ ...project, id: `chat:${sessionId}:${update.id}`, kind: 'chat', snapshot: { ...update, projectPath: chat.cwd } })
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  }
  if (fs.existsSync(wikiPath)) {
    const root = fs.realpathSync(wikiPath)
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(file); continue }
        if (!entry.isFile() || !entry.name.endsWith('.md') || !inside(root, fs.realpathSync(file))) continue
        const bytes = fs.readFileSync(file)
        if (bytes.length > 2 * 1024 * 1024) continue
        const project = wikiOwners.get(path.resolve(file)) || { projectId: 'shared-wiki', projectTitle: 'Shared knowledge', ownerSessionId: null, projectPath: wikiPath }
        sources.push({ ...project, id: `wiki:${path.relative(wikiPath, file)}`, kind: 'wiki', snapshot: { path: file, sha256: digest(bytes), projectPath: project.projectPath } })
      }
    }
    walk(wikiPath)
  }
  return sources
}

export function createProjectCommsRuntime({ store, root, wikiPath, readMeta, inbox, launch, sendTask, baseUrl, refresh = () => {}, readOnly = false, dispatchEnabled = true, commitWiki = commitWikiChanges, wikiCommitIntervalMs = 60_000, now = Date.now }) {
  const wikiCursors = createJsonState({ root, file: path.join(root, 'project-comms-wiki-cursors.json'), defaultValue: {}, validate: isJsonRecord, mode: 0o600 })
  let ticking = false, lastError = null, lastWikiCommitAt = 0
  // The wiki's history lives in git when the operator has initialised one.
  // Committing is throttled so a tick every few seconds does not shell out
  // each time; a failure is logged and never blocks the communications loop.
  async function snapshotWiki() {
    if (now() - lastWikiCommitAt < wikiCommitIntervalMs) return
    lastWikiCommitAt = now()
    try {
      const result = await commitWiki(wikiPath)
      if (result?.committed) console.log(`[project-comms] ${result.subject}`)
    } catch (error) { console.warn('[project-comms] wiki commit failed:', error.message) }
  }
  function collect() { return projectCommsSources(readMeta(), inbox, wikiPath) }
  function acknowledgeWiki(paths = []) {
    const edited = new Set(paths.map(file => path.resolve(file)))
    const hashes = Object.fromEntries(collect().filter(source => source.kind === 'wiki' && edited.has(path.resolve(source.snapshot.path))).map(source => [source.id, source.snapshot.sha256]))
    wikiCursors.update(current => ({ ...current, ...hashes }))
  }
  async function tick() {
    if (readOnly || !dispatchEnabled || ticking) return
    ticking = true
    try {
      await snapshotWiki()
      const state = store.read()
      if (state.paused) return
      const cursors = wikiCursors.read()
      const nextCursors = { ...cursors }
      const knownSources = new Set(state.sources.map(source => source.key))
      const sourceErrors = []
      for (const source of collect()) {
        try {
          if (source.kind === 'wiki' && state.jobs.some(job => job.role === 'caretaker' && job.status === 'running' && job.projectId === source.projectId)) continue
          if (source.kind === 'wiki' && cursors[source.id] === source.snapshot.sha256) continue
          const key = projectCommsSourceKey(source)
          if (!knownSources.has(key)) { store.ingest(source); knownSources.add(key) }
          if (source.kind === 'wiki') nextCursors[source.id] = source.snapshot.sha256
        } catch (error) {
          sourceErrors.push(`${source.projectTitle} (${source.id}): ${error.message}`)
        }
      }
      if (JSON.stringify(cursors) !== JSON.stringify(nextCursors)) wikiCursors.write(nextCursors)
      let feedChanged = false
      for (const delegation of store.pendingDelegations()) {
        if (store.read().paused) break
        try {
        const meta = readMeta()[delegation.ownerSessionId]
        if (!meta || meta.chatStandby || meta.chatProjectId !== delegation.projectId || meta.chatRole !== 'creator') throw new Error('Comment owner is no longer available')
        const doc = inbox.read(delegation.projectId)
        if (!doc.config) inbox.configure(delegation.projectId, { objective: `Work requested through comments on ${meta.title || 'this project'}.`, allowIdeas: false }, { sessionId: delegation.ownerSessionId, role: 'human' })
        inbox.add(delegation.projectId, { id: delegation.taskId, title: delegation.task.title, description: delegation.task.description }, { sessionId: delegation.ownerSessionId, role: 'human' })
        await sendTask(delegation)
        store.markDelegated(delegation.commentId, delegation.taskId)
        feedChanged = true
        } catch (error) { store.failDelegation(delegation.commentId, error.message); feedChanged = true }
      }
      // Completion is an explicit reviewed inbox result, never an idle-pane guess.
      for (const comment of store.read().comments) {
        if (!comment.delegation?.taskId || !comment.projectId || comment.status !== 'awaiting-task') continue
        const task = inbox.read(comment.projectId).tasks.find(task => task.id === comment.delegation.taskId)
        if (task?.status === 'done') feedChanged = Boolean(store.taskCompleted(comment.projectId, task.id, task.result)) || feedChanged
        else if (task?.status === 'blocked') feedChanged = Boolean(store.taskCompleted(comment.projectId, task.id, { status: 'blocked', title: task.title, reason: task.history.findLast(event => event.action === 'block')?.reason || 'The CR reported a blocker.' })) || feedChanged
      }
      if (!store.read().paused) {
        const job = store.leaseNext({ maxRunning: 2 })
        if (job) {
          const sessionId = randomUUID()
          store.assign(job.id, job.leaseToken, sessionId)
          try {
            const meta = readMeta()[job.ownerSessionId]
            const projectPath = meta?.cwd || wikiPath
            fs.mkdirSync(wikiPath, { recursive: true })
            const prompt = buildProjectCommsPrompt({ ...job, assignedSessionId: sessionId }, { callbackUrl: `${baseUrl}/api/internal/sessions/${sessionId}/project-comms/${job.id}`, wikiPath, projectPath })
            await launch({ id: sessionId, role: job.role, projectTitle: job.projectTitle, cwd: projectPath, prompt })
          } catch (error) { store.fail(job.id, { leaseToken: job.leaseToken, error: error.message }) }
        }
      }
      lastError = sourceErrors.length ? `${sourceErrors.length} source(s) need attention: ${sourceErrors.slice(0, 10).join('; ')}` : null
      if (feedChanged) refresh()
    } catch (error) { lastError = error.message; console.warn('[project-comms]', error.message) }
    finally { ticking = false }
  }
  function complete(jobId, sessionId, body) {
    if (readOnly) throw Object.assign(new Error('Read-only instance'), { status: 403 })
    const job = store.read().jobs.find(job => job.id === jobId)
    const result = store.complete(jobId, { sessionId, leaseToken: body.leaseToken, output: body.output })
    if (job?.role === 'caretaker' && job.status !== 'done') acknowledgeWiki(body.output?.wikiPaths || [])
    refresh()
    void tick()
    return result
  }
  function status() {
    const state = store.read()
    const delegations = state.comments.filter(comment => comment.delegation && !comment.delegation.dispatched).map(comment => ({
      id: `delegation:${comment.id}`, role: 'replyguy', projectId: comment.projectId,
      projectTitle: state.publications.find(item => item.id === comment.publicationId)?.projectTitle || 'Project',
      status: comment.delegation.status, attempts: comment.delegation.attempts, error: comment.delegation.error,
      updatedAt: new Date(comment.createdAt).toISOString(),
    }))
    const visibleJobs = [...state.jobs.filter(job => job.status !== 'done'), ...state.jobs.filter(job => job.status === 'done').slice(-100)].sort((a, b) => b.updatedAt - a.updatedAt)
    return { enabled: !state.paused, error: lastError, jobs: [...delegations, ...visibleJobs.map(job => ({ id: job.id, role: job.role, projectId: job.projectId, projectTitle: job.projectTitle, status: job.status, sessionId: job.assignedSessionId || job.lastSessionId, attempts: job.attempt, error: job.error, updatedAt: new Date(job.updatedAt).toISOString() }))] }
  }
  return { tick, complete, status }
}

export function projectCommsComment(comment, jobs = []) {
  const reply = comment.replies.at(-1)
  return { id: comment.id, evidenceId: `project-update:${comment.publicationId}`, room: comment.projectId,
    text: comment.body, createdAt: new Date(comment.createdAt).toISOString(), status: comment.status,
    taskId: comment.delegation?.taskId,
    taskStatus: comment.delegation?.result?.status,
    error: comment.delegation?.error || jobs.findLast(job => job.payload.commentId === comment.id && job.status === 'stalled')?.error || null,
    reply: reply ? { text: reply.body, timestamp: new Date(reply.createdAt).toISOString() } : null }
}

export function projectCommsFeed(store) {
  const state = store.read()
  return state.publications.map(publication => ({
    evidenceId: `project-update:${publication.id}`, kind: 'update', sourceKind: 'project',
    projectId: publication.projectId, room: publication.projectTitle, title: publication.title,
    summary: publication.summary + (publication.links?.length ? '\n\n' + publication.links.map(link => `[${link.label.replace(/[\[\]]/g, '')}](${link.url.replace(/\)/g, '%29')})`).join(' · ') : ''),
    detail: publication.evidence, occurredAt: new Date(publication.createdAt).toISOString(),
    sourceHref: publication.ownerSessionId ? `/#${publication.ownerSessionId}` : '/#wiki',
    sourceState: 'available', status: 'edited', needsReview: false, sessionId: publication.ownerSessionId,
    comments: state.comments.filter(comment => comment.publicationId === publication.id).map(comment => projectCommsComment(comment, state.jobs)),
  }))
}
