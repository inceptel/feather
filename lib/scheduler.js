// Feather scheduler: one table of wake rules for every chat Feather runs
// (OMP, Claude, Codex; Room Leaders, residents, fresh one-shot sessions).
//
// Every tick (30s) each rule is asked one question: should this fire now?
// The answer comes from cheap checks only: an interval or cron expression
// (croner does the calendar math), a parent rule that just finished, files
// that changed, a target that is idle. Launching is the adapter's job; the
// core here is pure and testable.
//
// Guards that keep it from doing dumb things:
//   - Missed windows coalesce. A rule due three times while Feather was
//     down fires once after boot, then resumes its cadence from that run.
//   - Boot grace. Nothing fires in the first BOOT_GRACE_MS after start.
//   - Launch spacing. At most MAX_LAUNCHES_PER_TICK per tick, one per Room
//     per tick, so a restart storm turns into a slow drip.
//   - No overlap. A rule with a run still in flight never fires again;
//     a run older than its timeout is closed as 'timeout' first.
//   - Per-rule rate cap. maxRunsPerHour (default 6); the cap wins.
//   - Chains fire once per parent run and cannot form a cycle.
//   - Crash backoff. Consecutive failures double the wait; after
//     MAX_FAILURES the rule pauses itself with a reason and the watchdog
//     says so, instead of retrying forever.
//   - Watchdog. A rule overdue by two intervals raises one incident.
import { Cron } from 'croner'

export const SCHEDULER_TICK_MS = 30_000
export const BOOT_GRACE_MS = 90_000
export const MAX_LAUNCHES_PER_TICK = 2
export const MAX_FAILURES = 5
export const DEFAULT_MAX_RUNS_PER_HOUR = 6
export const DEFAULT_TIMEOUT_MS = 60 * 60_000
export const MIN_EVERY_MS = 60_000
export const RULE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}\/[a-z0-9][a-z0-9-]{0,31}$/
export const ENGINES = Object.freeze(['omp', 'claude', 'codex'])
export const MODES = Object.freeze(['inject', 'fresh'])
export const TARGET_KINDS = Object.freeze(['leader', 'resident', 'session', 'new'])
export const CRITERIA = Object.freeze(['idle', 'file-changed', 'file-matches', 'frontier-has'])
export const RUN_OUTCOMES = Object.freeze(['done', 'failed', 'timeout', 'killed'])

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i
const DURATION_UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

export class SchedulerError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

function fail(message, status = 400) { throw new SchedulerError(message, status) }

export function parseDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.floor(value) : null
  const match = DURATION_RE.exec(String(value ?? '').trim())
  if (!match) return null
  const ms = Math.round(Number(match[1]) * DURATION_UNITS[(match[2] || 'm').toLowerCase()])
  return ms > 0 ? ms : null
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1_000 === 0) return `${ms / 1_000}s`
  return `${ms}ms`
}

function cronOf(expression) {
  try { return new Cron(expression, { timezone: 'UTC' }) } catch (error) { fail(`invalid cron "${expression}": ${error.message}`) }
}

function optionalText(value, label, max = 20_000) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') fail(`${label} must be a string`)
  if (value.length > max) fail(`${label} exceeds ${max} characters`)
  return value
}

function normalizeTarget(input) {
  if (!input || typeof input !== 'object') fail('target is required')
  const kind = input.kind
  if (!TARGET_KINDS.includes(kind)) fail(`target.kind must be one of ${TARGET_KINDS.join(', ')}`)
  if (kind === 'leader') return { kind }
  if (kind === 'resident') {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(String(input.role || ''))) fail('target.role must be a resident role')
    return { kind, role: input.role }
  }
  if (kind === 'session') {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(String(input.sessionId || ''))) fail('target.sessionId is required')
    return { kind, sessionId: input.sessionId }
  }
  const engine = input.engine || 'omp'
  if (!ENGINES.includes(engine)) fail(`target.engine must be one of ${ENGINES.join(', ')}`)
  return { kind, engine, model: optionalText(input.model, 'target.model', 200), title: optionalText(input.title, 'target.title', 200) }
}

function normalizeCriterion(input) {
  if (!input || typeof input !== 'object') fail('when entries must be objects')
  const type = input.type
  if (!CRITERIA.includes(type)) fail(`when.type must be one of ${CRITERIA.join(', ')}`)
  if (type === 'idle') {
    const forceAfterMs = input.forceAfterMs === undefined || input.forceAfterMs === null ? null : parseDuration(input.forceAfterMs)
    if (input.forceAfterMs !== undefined && input.forceAfterMs !== null && !forceAfterMs) fail('when.forceAfterMs must be a duration')
    return { type, forceAfterMs }
  }
  if (type === 'frontier-has') {
    const section = String(input.section || 'Review')
    if (!/^[A-Za-z][A-Za-z ]{0,31}$/.test(section)) fail('when.section must be a FRONTIER section name')
    return { type, section }
  }
  const file = String(input.path || '')
  if (!file || file.includes('..') || file.startsWith('/')) fail('when.path must be a relative path inside the Room')
  if (type === 'file-changed') return { type, path: file }
  const pattern = String(input.pattern || '')
  if (!pattern || pattern.length > 500) fail('when.pattern is required')
  try { new RegExp(pattern, 'm') } catch (error) { fail(`when.pattern is not a regex: ${error.message}`) }
  return { type, path: file, pattern }
}

/** Normalize one rule; throws SchedulerError on anything that is not a rule. */
export function normalizeRule(input) {
  if (!input || typeof input !== 'object') fail('rule must be an object')
  const id = String(input.id || '')
  if (!RULE_ID_RE.test(id)) fail('rule id must look like <room>/<name>')
  const room = id.split('/')[0]
  const target = normalizeTarget(input.target)
  const mode = input.mode ?? (target.kind === 'new' ? 'fresh' : 'inject')
  if (!MODES.includes(mode)) fail(`mode must be one of ${MODES.join(', ')}`)
  if (mode === 'fresh' && target.kind !== 'new' && target.kind !== 'leader') fail('mode fresh needs target.kind new or leader')
  if (mode === 'inject' && target.kind === 'new') fail('target.kind new needs mode fresh')
  const every = input.every === undefined || input.every === null || input.every === '' ? null : parseDuration(input.every)
  if (input.every && !every) fail('every must be a duration like 30m or 2h')
  if (every && every < MIN_EVERY_MS) fail(`every must be at least ${formatDuration(MIN_EVERY_MS)}`)
  const cron = optionalText(input.cron, 'cron', 100)
  if (cron) cronOf(cron)
  const after = optionalText(input.after, 'after', 70)
  if (after && !RULE_ID_RE.test(after)) fail('after must be a rule id')
  if (after === id) fail('a rule cannot run after itself')
  if (!every && !cron && !after) fail('a rule needs every, cron, or after')
  if (every && cron) fail('use every or cron, not both')
  const when = Array.isArray(input.when) ? input.when.map(normalizeCriterion) : []
  if (when.length > 8) fail('at most 8 when criteria')
  const timeoutMs = input.timeoutMs === undefined || input.timeoutMs === null ? DEFAULT_TIMEOUT_MS : parseDuration(input.timeoutMs)
  if (!timeoutMs) fail('timeoutMs must be a duration')
  const maxRunsPerHour = input.maxRunsPerHour === undefined || input.maxRunsPerHour === null ? DEFAULT_MAX_RUNS_PER_HOUR : Number(input.maxRunsPerHour)
  if (!Number.isInteger(maxRunsPerHour) || maxRunsPerHour < 1 || maxRunsPerHour > 60) fail('maxRunsPerHour must be 1..60')
  return {
    id, room, target, mode, every, cron, after, when,
    prompt: optionalText(input.prompt, 'prompt'),
    timeoutMs, maxRunsPerHour,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    note: optionalText(input.note, 'note', 500),
  }
}

/** Validate a whole rule table: ids match keys, chains resolve, no cycles. */
export function validateRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) fail('rules must be an object keyed by id')
  const normalized = {}
  for (const [key, rule] of Object.entries(rules)) {
    const entry = normalizeRule(rule)
    if (entry.id !== key) fail(`rule key ${key} does not match id ${entry.id}`)
    normalized[key] = entry
  }
  for (const rule of Object.values(normalized)) {
    if (!rule.after) continue
    if (!normalized[rule.after]) fail(`${rule.id} runs after ${rule.after}, which does not exist`)
    const seen = new Set([rule.id])
    let cursor = normalized[rule.after]
    while (cursor) {
      if (seen.has(cursor.id)) fail(`after-chain cycle through ${cursor.id}`)
      seen.add(cursor.id)
      cursor = cursor.after ? normalized[cursor.after] : null
    }
  }
  return normalized
}

export function emptyRuntime() {
  return {
    lastRunAt: null, lastRunId: null, lastOutcome: null, nextDueAt: null,
    consecutiveFailures: 0, afterRunId: null, pausedReason: null, paused: false,
    recentStarts: [], incidentAt: null,
  }
}

export function runtimeOf(state, id) {
  const entry = state?.runtime?.[id]
  return { ...emptyRuntime(), ...(entry && typeof entry === 'object' ? entry : {}) }
}

/** Calendar math only: when is this rule next due, given its last run. */
export function nextDueAt(rule, runtime, { bootAt }) {
  const anchor = Date.parse(runtime.lastRunAt || '') || bootAt
  if (rule.cron) {
    const next = cronOf(rule.cron).nextRun(new Date(anchor))
    return next ? next.getTime() : null
  }
  if (rule.every) return anchor + rule.every
  return null
}

function backoffMs(failures) {
  if (!failures) return 0
  return Math.min(60 * 60_000, 60_000 * 2 ** (failures - 1))
}

function withinHour(recentStarts, now) {
  return (recentStarts || []).filter((iso) => now - Date.parse(iso) < 3_600_000)
}

/**
 * Decide, for one rule, whether it should fire now. Returns
 * { fire: boolean, reason, dueAt } where reason names the guard that held it.
 * `context` is the cheap-checks provider supplied by the adapter.
 */
export function evaluateRule(rule, runtime, context) {
  const { now, bootAt, parentRuntime = null, activeRun = null } = context
  const dueAt = nextDueAt(rule, runtime, { bootAt })
  const result = (fire, reason) => ({ fire, reason, dueAt })
  if (!rule.enabled) return result(false, 'disabled')
  if (runtime.paused) return result(false, runtime.pausedReason ? `paused: ${runtime.pausedReason}` : 'paused')
  if (activeRun) return result(false, `running since ${activeRun.startedAt}`)
  if (now - bootAt < (context.bootGraceMs ?? BOOT_GRACE_MS)) return result(false, 'boot grace')
  const starts = withinHour(runtime.recentStarts, now)
  if (starts.length >= rule.maxRunsPerHour) return result(false, `rate cap ${rule.maxRunsPerHour}/h`)
  const backoff = backoffMs(runtime.consecutiveFailures)
  if (backoff && runtime.lastRunAt && now - Date.parse(runtime.lastRunAt) < backoff) {
    return result(false, `backoff ${formatDuration(backoff)} after ${runtime.consecutiveFailures} failures`)
  }
  let trigger = null
  if (rule.after) {
    const parentRunId = parentRuntime?.lastRunId || null
    const parentDone = Boolean(parentRuntime?.lastOutcome)
    if (parentRunId && parentDone && runtime.afterRunId !== parentRunId) trigger = `after ${rule.after}`
  }
  if (!trigger && dueAt !== null && now >= dueAt) trigger = rule.cron ? `cron ${rule.cron}` : `every ${formatDuration(rule.every)}`
  if (!trigger) return result(false, dueAt ? `next ${new Date(dueAt).toISOString()}` : `waiting for ${rule.after}`)
  const triggerAt = dueAt !== null && now >= dueAt ? dueAt : (Date.parse(parentRuntime?.lastFinishedAt || '') || now)
  for (const criterion of rule.when) {
    const held = checkCriterion(criterion, rule, runtime, { ...context, triggerAt })
    if (held !== true) return result(false, held)
  }
  return result(true, trigger)
}

/** Returns true when the criterion allows firing, else a short reason. */
export function checkCriterion(criterion, rule, runtime, context) {
  const { now } = context
  if (criterion.type === 'idle') {
    const idle = context.targetIdle?.()
    if (idle === true || idle === null || idle === undefined) return true
    // Wait for the target's turn to end, but not forever: one forceAfter
    // past the moment the rule became due, fire anyway (the harness queues it).
    const forceAfter = criterion.forceAfterMs ?? rule.every ?? 30 * 60_000
    const since = context.triggerAt ?? now
    if (now - since >= forceAfter) return true
    return `target mid-turn (forces at ${new Date(since + forceAfter).toISOString()})`
  }
  if (criterion.type === 'file-changed') {
    const mtime = context.fileMtime?.(criterion.path)
    if (!mtime) return `${criterion.path} missing`
    const since = Date.parse(runtime.lastRunAt || '') || 0
    return mtime > since ? true : `${criterion.path} unchanged since last run`
  }
  if (criterion.type === 'file-matches') {
    const text = context.fileText?.(criterion.path)
    if (typeof text !== 'string') return `${criterion.path} missing`
    return new RegExp(criterion.pattern, 'm').test(text) ? true : `${criterion.path} does not match`
  }
  if (criterion.type === 'frontier-has') {
    const text = context.fileText?.('FRONTIER.md')
    if (typeof text !== 'string') return 'FRONTIER.md missing'
    return frontierSectionHasLines(text, criterion.section) ? true : `FRONTIER ${criterion.section} is empty`
  }
  return `unknown criterion ${criterion.type}`
}

export function frontierSectionHasLines(text, section) {
  const lines = String(text).split('\n')
  let inside = false
  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) { inside = heading[1].toLowerCase() === section.toLowerCase(); continue }
    if (inside && /^\s*[-*]\s+\S/.test(line)) return true
  }
  return false
}

/**
 * Plan one tick: which rules fire now, in order, under the launch guards.
 * Pure: takes the rule table, runtime, active runs, and a context factory.
 */
export function planTick({ rules, runtime, activeRuns, now, bootAt, bootGraceMs = BOOT_GRACE_MS, maxLaunches = MAX_LAUNCHES_PER_TICK, contextFor }) {
  const decisions = []
  const activeByRule = new Map()
  for (const run of activeRuns) activeByRule.set(run.ruleId, run)
  for (const rule of Object.values(rules)) {
    const context = {
      now, bootAt, bootGraceMs,
      activeRun: activeByRule.get(rule.id) || null,
      parentRuntime: rule.after ? runtimeOf({ runtime }, rule.after) : null,
      ...(contextFor ? contextFor(rule) : {}),
    }
    const decision = evaluateRule(rule, runtimeOf({ runtime }, rule.id), context)
    decisions.push({ rule, ...decision })
  }
  const launches = []
  const roomsThisTick = new Set()
  const ready = decisions.filter((d) => d.fire).sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0) || (a.rule.id < b.rule.id ? -1 : 1))
  for (const decision of ready) {
    if (launches.length >= maxLaunches) { decision.fire = false; decision.reason = 'launch cap this tick'; continue }
    if (roomsThisTick.has(decision.rule.room)) { decision.fire = false; decision.reason = 'room already launched this tick'; continue }
    roomsThisTick.add(decision.rule.room)
    launches.push(decision)
  }
  return { decisions, launches }
}

/** Runtime after a run starts. */
export function markStarted(runtime, { runId, at, parentRunId = null }) {
  const startedAt = new Date(at).toISOString()
  return {
    ...runtime,
    lastRunAt: startedAt,
    lastRunId: runId,
    lastOutcome: null,
    afterRunId: parentRunId ?? runtime.afterRunId,
    recentStarts: [...withinHour(runtime.recentStarts, at), startedAt].slice(-60),
    incidentAt: null,
  }
}

/** Runtime after a run ends. Failures pause the rule after MAX_FAILURES. */
export function markFinished(runtime, { outcome, at, maxFailures = MAX_FAILURES }) {
  if (!RUN_OUTCOMES.includes(outcome)) throw new SchedulerError(`bad outcome ${outcome}`, 500)
  const failed = outcome === 'failed' || outcome === 'timeout'
  const consecutiveFailures = failed ? runtime.consecutiveFailures + 1 : 0
  const paused = consecutiveFailures >= maxFailures
  return {
    ...runtime,
    lastOutcome: outcome,
    lastFinishedAt: new Date(at).toISOString(),
    consecutiveFailures,
    ...(paused ? { paused: true, pausedReason: `${consecutiveFailures} runs in a row ended in ${outcome}` } : {}),
  }
}

/** A rule is overdue when two intervals have passed since it was due. */
export function overdueAt(rule, runtime, { bootAt }) {
  const dueAt = nextDueAt(rule, runtime, { bootAt })
  const span = rule.every || (rule.cron ? 3_600_000 : null)
  if (dueAt === null || !span || !rule.enabled || runtime.paused) return null
  return dueAt + 2 * span
}

/** Which rules deserve a watchdog incident right now (not yet raised). */
export function findIncidents({ rules, runtime, activeRuns, now, bootAt }) {
  const incidents = []
  const activeByRule = new Set(activeRuns.map((run) => run.ruleId))
  for (const rule of Object.values(rules)) {
    const entry = runtimeOf({ runtime }, rule.id)
    if (entry.incidentAt) continue
    if (entry.paused && entry.pausedReason) {
      incidents.push({ rule, kind: 'paused', detail: entry.pausedReason })
      continue
    }
    if (activeByRule.has(rule.id)) continue
    const at = overdueAt(rule, entry, { bootAt })
    if (at !== null && now >= at) incidents.push({ rule, kind: 'overdue', detail: `due ${new Date(nextDueAt(rule, entry, { bootAt })).toISOString()}, still not started` })
  }
  return incidents
}

/** Runs still open whose timeout has passed. */
export function expiredRuns(activeRuns, rules, now) {
  return activeRuns.filter((run) => {
    const rule = rules[run.ruleId]
    const timeout = rule?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return now - Date.parse(run.startedAt) >= timeout
  })
}

/** Small summary for the API and the CLI. */
export function describeRule(rule, runtime, activeRun, { now, bootAt }) {
  const dueAt = nextDueAt(rule, runtime, { bootAt })
  return {
    ...rule,
    every: rule.every ? formatDuration(rule.every) : null,
    everyMs: rule.every,
    runtime: {
      ...runtime,
      nextDueAt: dueAt ? new Date(dueAt).toISOString() : null,
      overdue: (() => { const at = overdueAt(rule, runtime, { bootAt }); return at !== null && now >= at })(),
      running: activeRun ? { runId: activeRun.runId, startedAt: activeRun.startedAt, sessionId: activeRun.sessionId || null } : null,
    },
  }
}
