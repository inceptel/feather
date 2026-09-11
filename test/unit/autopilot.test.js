import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mayReenableRalph, stopScheduledRules, scheduledRunMayContinue } from '../../lib/autopilot.js'

test('a human restarts a stopped Ralph; peer input cannot restart it', () => {
  const stopped = { enabled: false, status: 'stopped' }
  assert.equal(mayReenableRalph(stopped, 'human'), true)
  assert.equal(mayReenableRalph(stopped, 'agent'), false)
  assert.equal(mayReenableRalph({ enabled: true, status: 'working' }, 'agent'), true)
})

test('stopping future work preserves rules, chat identities, and evidence', () => {
  const run = { runId: 'run-a', ruleId: 'boat/check', sessionId: 'creator', agent: { checkerSessionId: 'reviewer' } }
  const state = { rules: { 'boat/check': { enabled: true } }, runtime: {}, active: [run] }
  const stopped = stopScheduledRules(state, ['boat/check'])
  assert.equal(scheduledRunMayContinue(stopped, run), false)
  assert.deepEqual(stopped.active, [run])
  assert.equal(state.rules['boat/check'].enabled, true)
  assert.equal(JSON.parse(JSON.stringify(stopped)).rules['boat/check'].enabled, false)
})
