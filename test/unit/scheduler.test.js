import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeRule, validateRules, evaluateRule, planTick, markStarted, markFinished,
  nextDueAt, emptyRuntime, findIncidents, expiredRuns, frontierSectionHasLines,
  parseDuration, formatDuration, SchedulerError, MAX_FAILURES,
} from '../../lib/scheduler.js'

const T0 = Date.parse('2026-09-07T12:00:00Z')
const H = 3_600_000
const leader = { id: 'trading/leader', target: { kind: 'leader' }, mode: 'fresh', every: '1h' }
const caretaker = { id: 'trading/caretaker', target: { kind: 'resident', role: 'caretaker' }, after: 'trading/leader', when: [{ type: 'idle' }] }
const judge = { id: 'trading/judge', target: { kind: 'resident', role: 'judge' }, after: 'trading/caretaker', when: [{ type: 'frontier-has', section: 'Review' }] }

function ctx(extra = {}) {
  return { now: T0 + 2 * H, bootAt: T0, bootGraceMs: 0, ...extra }
}

describe('scheduler rules', () => {
  it('parses durations both ways', () => {
    assert.equal(parseDuration('30m'), 30 * 60_000)
    assert.equal(parseDuration('2h'), 2 * H)
    assert.equal(parseDuration('90s'), 90_000)
    assert.equal(parseDuration('nope'), null)
    assert.equal(formatDuration(90 * 60_000), '90m')
    assert.equal(formatDuration(2 * H), '2h')
  })

  it('normalizes a rule and rejects bad ones', () => {
    const rule = normalizeRule(leader)
    assert.equal(rule.room, 'trading')
    assert.equal(rule.every, H)
    assert.equal(rule.mode, 'fresh')
    assert.equal(rule.enabled, true)
    assert.throws(() => normalizeRule({ ...leader, id: 'Trading/Leader' }), SchedulerError)
    assert.throws(() => normalizeRule({ ...leader, every: '10s' }), /at least 1m/)
    assert.throws(() => normalizeRule({ ...leader, every: null }), /needs every, cron, or after/)
    assert.throws(() => normalizeRule({ ...leader, cron: 'not a cron', every: null }), /invalid cron/)
    assert.throws(() => normalizeRule({ ...leader, after: 'trading/leader', every: null }), /after itself/)
    assert.throws(() => normalizeRule({ id: 'a/b', target: { kind: 'new' }, mode: 'inject', every: '1h' }), /needs mode fresh/)
    assert.throws(() => normalizeRule({ ...caretaker, when: [{ type: 'file-changed', path: '../x' }] }), /relative path/)
    assert.equal(normalizeRule({ ...leader, cron: '0 * * * *', every: null }).cron, '0 * * * *')
  })

  it('validates chains: missing parents and cycles fail', () => {
    const table = validateRules({ [leader.id]: leader, [caretaker.id]: caretaker, [judge.id]: judge })
    assert.deepEqual(Object.keys(table), [leader.id, caretaker.id, judge.id])
    assert.throws(() => validateRules({ [caretaker.id]: caretaker }), /does not exist/)
    const a = { id: 'r/a', target: { kind: 'leader' }, after: 'r/b' }
    const b = { id: 'r/b', target: { kind: 'leader' }, after: 'r/a' }
    assert.throws(() => validateRules({ 'r/a': a, 'r/b': b }), /cycle/)
    assert.throws(() => validateRules({ 'r/x': a }), /does not match/)
  })
})

describe('scheduler decisions', () => {
  it('fires an interval rule once when several windows were missed (restart coalescing)', () => {
    const rule = normalizeRule(leader)
    const runtime = { ...emptyRuntime(), lastRunAt: new Date(T0 - 5 * H).toISOString() }
    const first = evaluateRule(rule, runtime, ctx({ now: T0 }))
    assert.equal(first.fire, true)
    const started = markStarted(runtime, { runId: 'r1', at: T0 })
    const again = evaluateRule(rule, markFinished(started, { outcome: 'done', at: T0 + 60_000 }), ctx({ now: T0 + 2 * 60_000 }))
    assert.equal(again.fire, false)
    assert.match(again.reason, /^next 2026-09-07T13:00/)
  })

  it('holds everything during boot grace', () => {
    const rule = normalizeRule(leader)
    const runtime = { ...emptyRuntime(), lastRunAt: new Date(T0 - 5 * H).toISOString() }
    const held = evaluateRule(rule, runtime, { now: T0 + 10_000, bootAt: T0, bootGraceMs: 90_000 })
    assert.equal(held.fire, false)
    assert.equal(held.reason, 'boot grace')
  })

  it('never fires while a run is in flight', () => {
    const rule = normalizeRule(leader)
    const decision = evaluateRule(rule, emptyRuntime(), ctx({ activeRun: { ruleId: rule.id, startedAt: '2026-09-07T12:30:00Z' } }))
    assert.equal(decision.fire, false)
    assert.match(decision.reason, /running since/)
  })

  it('applies the per-rule hourly rate cap', () => {
    const rule = normalizeRule({ ...leader, every: '1m', maxRunsPerHour: 2 })
    let runtime = emptyRuntime()
    for (let i = 0; i < 2; i++) {
      runtime = markFinished(markStarted(runtime, { runId: `r${i}`, at: T0 + i * 60_000 }), { outcome: 'done', at: T0 + i * 60_000 + 1000 })
    }
    const decision = evaluateRule(rule, runtime, ctx({ now: T0 + 10 * 60_000 }))
    assert.equal(decision.fire, false)
    assert.equal(decision.reason, 'rate cap 2/h')
  })

  it('chains fire once per parent run', () => {
    const rules = validateRules({ [leader.id]: leader, [caretaker.id]: caretaker })
    let parent = markFinished(markStarted(emptyRuntime(), { runId: 'L1', at: T0 }), { outcome: 'done', at: T0 + 60_000 })
    let child = emptyRuntime()
    const context = ctx({ parentRuntime: parent, targetIdle: () => true })
    assert.equal(evaluateRule(rules[caretaker.id], child, context).fire, true)
    child = markStarted(child, { runId: 'C1', at: T0 + 2 * 60_000, parentRunId: 'L1' })
    child = markFinished(child, { outcome: 'done', at: T0 + 3 * 60_000 })
    assert.equal(evaluateRule(rules[caretaker.id], child, context).fire, false)
    parent = markFinished(markStarted(parent, { runId: 'L2', at: T0 + H }), { outcome: 'done', at: T0 + H + 60_000 })
    assert.equal(evaluateRule(rules[caretaker.id], child, ctx({ now: T0 + H + 2 * 60_000, parentRuntime: parent, targetIdle: () => true })).fire, true)
  })

  it('a chain does not fire while its parent is still running', () => {
    const rules = validateRules({ [leader.id]: leader, [caretaker.id]: caretaker })
    const parent = markStarted(emptyRuntime(), { runId: 'L1', at: T0 })
    const decision = evaluateRule(rules[caretaker.id], emptyRuntime(), ctx({ parentRuntime: parent, targetIdle: () => true }))
    assert.equal(decision.fire, false)
    assert.equal(decision.reason, 'waiting for trading/leader')
  })

  it('idle waits for the target, then forces after the cap', () => {
    const rule = normalizeRule({ ...leader, mode: 'inject', when: [{ type: 'idle', forceAfterMs: '20m' }] })
    const runtime = { ...emptyRuntime(), lastRunAt: new Date(T0).toISOString() }
    const busy = evaluateRule(rule, runtime, ctx({ now: T0 + H + 60_000, targetIdle: () => false }))
    assert.equal(busy.fire, false)
    assert.match(busy.reason, /mid-turn/)
    const forced = evaluateRule(rule, runtime, ctx({ now: T0 + H + 21 * 60_000, targetIdle: () => false }))
    assert.equal(forced.fire, true)
  })

  it('file and FRONTIER criteria', () => {
    const rules = validateRules({ [leader.id]: leader, [caretaker.id]: caretaker, [judge.id]: judge })
    const parent = markFinished(markStarted(emptyRuntime(), { runId: 'C1', at: T0 }), { outcome: 'done', at: T0 + 1000 })
    const empty = '# FRONTIER\n\n## Review\n\n## Done\n- old\n'
    const full = '# FRONTIER\n\n## Review\n- Verified page (wiki/X.md)\n\n## Done\n'
    assert.equal(frontierSectionHasLines(empty, 'Review'), false)
    assert.equal(frontierSectionHasLines(full, 'Review'), true)
    const held = evaluateRule(rules[judge.id], emptyRuntime(), ctx({ parentRuntime: parent, fileText: () => empty }))
    assert.equal(held.fire, false)
    assert.equal(held.reason, 'FRONTIER Review is empty')
    assert.equal(evaluateRule(rules[judge.id], emptyRuntime(), ctx({ parentRuntime: parent, fileText: () => full })).fire, true)
    const changed = normalizeRule({ ...leader, when: [{ type: 'file-changed', path: 'notes.md' }] })
    const runtime = { ...emptyRuntime(), lastRunAt: new Date(T0).toISOString() }
    assert.equal(evaluateRule(changed, runtime, ctx({ fileMtime: () => T0 - 1 })).fire, false)
    assert.equal(evaluateRule(changed, runtime, ctx({ fileMtime: () => T0 + 5 })).fire, true)
  })

  it('backs off after failures and pauses itself after MAX_FAILURES', () => {
    const rule = normalizeRule({ ...leader, every: '1m', maxRunsPerHour: 60 })
    let runtime = emptyRuntime()
    let at = T0
    for (let i = 0; i < MAX_FAILURES; i++) {
      runtime = markFinished(markStarted(runtime, { runId: `r${i}`, at }), { outcome: 'failed', at: at + 1000 })
      at += 2 * H
    }
    assert.equal(runtime.paused, true)
    assert.match(runtime.pausedReason, /5 runs in a row/)
    const decision = evaluateRule(rule, runtime, ctx({ now: at + H }))
    assert.equal(decision.fire, false)
    assert.match(decision.reason, /^paused: 5 runs/)
    const twoFailures = markFinished(markStarted(emptyRuntime(), { runId: 'x', at: T0 }), { outcome: 'timeout', at: T0 + 1 })
    const backoff = evaluateRule(rule, markFinished(markStarted(twoFailures, { runId: 'y', at: T0 + 60_000 }), { outcome: 'timeout', at: T0 + 60_001 }), ctx({ now: T0 + 2 * 60_000 }))
    assert.equal(backoff.fire, false)
    assert.match(backoff.reason, /backoff 2m after 2 failures/)
  })
})

describe('scheduler ticks', () => {
  it('spreads a restart burst: launch cap per tick and one per Room', () => {
    const rules = validateRules({
      'a/one': { id: 'a/one', target: { kind: 'leader' }, every: '1h' },
      'a/two': { id: 'a/two', target: { kind: 'resident', role: 'judge' }, every: '1h' },
      'b/one': { id: 'b/one', target: { kind: 'leader' }, every: '1h' },
      'c/one': { id: 'c/one', target: { kind: 'leader' }, every: '1h' },
    })
    const stale = new Date(T0 - 9 * H).toISOString()
    const runtime = Object.fromEntries(Object.keys(rules).map((id) => [id, { ...emptyRuntime(), lastRunAt: stale }]))
    const plan = planTick({ rules, runtime, activeRuns: [], now: T0, bootAt: T0 - 10 * 60_000, contextFor: () => ({}) })
    assert.deepEqual(plan.launches.map((d) => d.rule.id), ['a/one', 'b/one'])
    const held = Object.fromEntries(plan.decisions.map((d) => [d.rule.id, d.reason]))
    assert.equal(held['a/two'], 'room already launched this tick')
    assert.equal(held['c/one'], 'launch cap this tick')
  })

  it('cron rules use the calendar and coalesce after downtime', () => {
    const rule = normalizeRule({ id: 'a/hourly', target: { kind: 'leader' }, cron: '0 * * * *' })
    const runtime = { ...emptyRuntime(), lastRunAt: '2026-09-07T05:00:10Z' }
    assert.equal(nextDueAt(rule, runtime, { bootAt: T0 }), Date.parse('2026-09-07T06:00:00Z'))
    assert.equal(evaluateRule(rule, runtime, ctx({ now: T0 })).fire, true)
    const after = markStarted(runtime, { runId: 'r', at: T0 + 5000 })
    assert.equal(nextDueAt(rule, after, { bootAt: T0 }), Date.parse('2026-09-07T13:00:00Z'))
  })

  it('finds overdue and self-paused rules once', () => {
    const rules = validateRules({ [leader.id]: leader })
    const runtime = { [leader.id]: { ...emptyRuntime(), lastRunAt: new Date(T0 - 4 * H).toISOString() } }
    const incidents = findIncidents({ rules, runtime, activeRuns: [], now: T0, bootAt: T0 - 5 * H })
    assert.equal(incidents.length, 1)
    assert.equal(incidents[0].kind, 'overdue')
    const silenced = { [leader.id]: { ...runtime[leader.id], incidentAt: new Date(T0).toISOString() } }
    assert.equal(findIncidents({ rules, runtime: silenced, activeRuns: [], now: T0, bootAt: T0 - 5 * H }).length, 0)
    const running = findIncidents({ rules, runtime, activeRuns: [{ ruleId: leader.id, startedAt: new Date(T0).toISOString() }], now: T0, bootAt: T0 - 5 * H })
    assert.equal(running.length, 0)
  })

  it('closes runs past their timeout', () => {
    const rules = validateRules({ [leader.id]: { ...leader, timeoutMs: '10m' } })
    const runs = [
      { ruleId: leader.id, runId: 'old', startedAt: new Date(T0 - 11 * 60_000).toISOString() },
      { ruleId: leader.id, runId: 'new', startedAt: new Date(T0 - 60_000).toISOString() },
    ]
    assert.deepEqual(expiredRuns(runs, rules, T0).map((run) => run.runId), ['old'])
  })
})
