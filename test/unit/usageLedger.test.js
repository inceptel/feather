import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { parseClaudeTranscript, parseOmpTranscript, parseCodexTranscript, createUsageLedger, summarizeUsage, roomForCwd } from '../../lib/usage-ledger.js'
import { normalizeAnthropicUsage, normalizeCodexRateLimits, readOpenRouterKey, createProviderLimits } from '../../lib/provider-limits.js'

const roots = []
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }) })

const ROOMS = '/home/u/rooms'
const T0 = Date.parse('2026-09-06T12:00:00Z')
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString()

function claudeLine(id, extra = {}) {
  return JSON.stringify({
    type: 'assistant', timestamp: iso(0), cwd: `${ROOMS}/feather`, sessionId: 'sess-claude',
    message: { id, model: 'claude-fable-5-1', usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 }, ...extra },
  })
}

describe('usage ledger parsers', () => {
  it('reads Claude Code usage once per message id and maps cwd to a Room', () => {
    const text = [
      claudeLine('msg-1'), claudeLine('msg-1'), claudeLine('msg-1'),
      claudeLine('msg-2'),
      JSON.stringify({ type: 'assistant', timestamp: iso(0), message: { id: 'msg-3', model: '<synthetic>', usage: { output_tokens: 1 } } }),
      JSON.stringify({ type: 'user', timestamp: iso(0), message: { role: 'user', content: 'hi' } }),
      'not json',
    ].join('\n')
    const events = parseClaudeTranscript(text, { roomsDir: ROOMS })
    assert.equal(events.length, 2)
    assert.deepEqual(events[0], {
      at: T0, harness: 'claude', provider: 'anthropic', model: 'claude-fable-5-1', sessionId: 'sess-claude',
      cwd: `${ROOMS}/feather`, room: 'feather', input: 2, output: 50, cacheRead: 1000, cacheWrite: 100, cost: null,
    })
  })

  it('reads OMP usage with the harness cost and the session cwd', () => {
    const text = [
      JSON.stringify({ type: 'session', version: 3, id: 'omp-1', timestamp: iso(0), cwd: `${ROOMS}/ev-shop-815` }),
      JSON.stringify({ type: 'message', timestamp: iso(1000), message: { role: 'assistant', model: 'gpt-5.6-sol', provider: 'openai-codex', usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, cost: { total: 0.25 } } } }),
      JSON.stringify({ type: 'message', timestamp: iso(2000), message: { role: 'user', content: 'x', usage: { input: 1 } } }),
    ].join('\n')
    const events = parseOmpTranscript(text, { sessionId: 'feather-1', roomsDir: ROOMS })
    assert.equal(events.length, 1)
    assert.equal(events[0].room, 'ev-shop-815')
    assert.equal(events[0].cost, 0.25)
    assert.equal(events[0].provider, 'openai-codex')
    assert.equal(parseOmpTranscript(text, { roomsDir: ROOMS, room: 'assigned' })[0].room, 'assigned')
  })

  it('turns Codex cumulative totals into per-turn usage and keeps the last rate limits', () => {
    const totals = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output })
    const text = [
      JSON.stringify({ timestamp: iso(0), type: 'session_meta', payload: { id: 'codex-1', cwd: `${ROOMS}/allanstream` } }),
      JSON.stringify({ timestamp: iso(10), type: 'turn_context', payload: { cwd: `${ROOMS}/allanstream`, model: 'gpt-5.6-sol' } }),
      JSON.stringify({ timestamp: iso(20), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: totals(1000, 0, 100), last_token_usage: totals(1000, 0, 100) }, rate_limits: { primary: { used_percent: 3, window_minutes: 10080, resets_at: 1787708024 } } } }),
      JSON.stringify({ timestamp: iso(30), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: totals(1500, 400, 130), last_token_usage: totals(500, 400, 30) }, rate_limits: { primary: { used_percent: 4, window_minutes: 10080, resets_at: 1787708024 }, secondary: { used_percent: 50, window_minutes: 300, resets_at: 1787708024 } } } }),
    ].join('\n')
    const { events, rateLimits } = parseCodexTranscript(text, { roomsDir: ROOMS })
    assert.equal(events.length, 2)
    assert.equal(events[0].input, 1000)
    assert.equal(events[1].input, 100)
    assert.equal(events[1].cacheRead, 400)
    assert.equal(events[1].output, 30)
    assert.equal(events[1].model, 'gpt-5.6-sol')
    assert.equal(events[1].room, 'allanstream')
    assert.equal(rateLimits.primary.used_percent, 4)
    assert.deepEqual(normalizeCodexRateLimits(rateLimits).map(w => [w.name, w.utilization]), [['7d', 0.04], ['5h', 0.5]])
  })

  it('maps cwd to Rooms only inside the rooms directory', () => {
    assert.equal(roomForCwd(`${ROOMS}/feather/sub`, ROOMS), 'feather')
    assert.equal(roomForCwd('/home/u/feather', ROOMS), null)
    assert.equal(roomForCwd(`${ROOMS}/../x`, ROOMS), null)
    assert.equal(roomForCwd(null, ROOMS), null)
  })
})

describe('usage ledger scan and summary', () => {
  it('scans every harness directory, caches unchanged files, and summarizes windows', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-usage-'))
    roots.push(root)
    const rooms = path.join(root, 'rooms')
    const claudeDir = path.join(root, 'claude/-home-u-rooms-feather')
    const ompDir = path.join(root, 'omp/feather-session-1')
    const codexDir = path.join(root, 'codex/2026/09/06')
    for (const dir of [claudeDir, ompDir, codexDir]) fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    const at = (offset) => new Date(now + offset).toISOString()
    fs.writeFileSync(path.join(claudeDir, 'sess-1.jsonl'), [
      JSON.stringify({ type: 'assistant', timestamp: at(-60_000), cwd: `${rooms}/feather`, message: { id: 'a', model: 'claude-fable-5-1', usage: { input_tokens: 10, output_tokens: 5 } } }),
      JSON.stringify({ type: 'assistant', timestamp: at(-6 * 3_600_000), cwd: `${rooms}/feather`, message: { id: 'b', model: 'claude-fable-5-1', usage: { input_tokens: 20, output_tokens: 5 } } }),
    ].join('\n'))
    fs.writeFileSync(path.join(ompDir, 'x.jsonl'), [
      JSON.stringify({ type: 'session', cwd: '/elsewhere' }),
      JSON.stringify({ type: 'message', timestamp: at(-120_000), message: { role: 'assistant', model: 'gpt-5.6-sol', provider: 'openai-codex', usage: { input: 100, output: 10, cost: { total: 0.5 } } } }),
    ].join('\n'))
    fs.writeFileSync(path.join(codexDir, 'rollout-1.jsonl'), [
      JSON.stringify({ timestamp: at(-30_000), type: 'session_meta', payload: { id: 'codex-1', cwd: `${rooms}/allanstream` } }),
      JSON.stringify({ timestamp: at(-20_000), type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      JSON.stringify({ timestamp: at(-10_000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 3, total_tokens: 303 }, last_token_usage: null }, rate_limits: { primary: { used_percent: 9, window_minutes: 10080 } } } }),
    ].join('\n'))
    const ledger = createUsageLedger({
      claudeProjectsDir: path.join(root, 'claude'), ompSessionsDir: path.join(root, 'omp'), codexSessionsDir: path.join(root, 'codex'),
      roomsDir: rooms, readAssignments: () => ({ 'feather-session-1': 'ev-shop-815' }),
    })
    const first = ledger.scan()
    assert.equal(first.files, 3)
    assert.equal(first.events.length, 4)
    assert.equal(first.codexRateLimits.primary.used_percent, 9)
    assert.equal(ledger.cacheSize(), 3)
    const windows = summarizeUsage(first.events, { now })
    const five = windows.find(w => w.key === '5h')
    assert.equal(five.totals.requests, 3)
    assert.equal(five.totals.input, 10 + 100 + 200)
    assert.equal(five.totals.cacheRead, 100)
    assert.equal(five.totals.cost, 0.5)
    assert.equal(five.totals.costedRequests, 1)
    assert.deepEqual(five.byRoom.map(r => r.room).sort(), ['allanstream', 'ev-shop-815', 'feather'])
    assert.equal(five.byHarness.length, 3)
    const day = windows.find(w => w.key === '24h')
    assert.equal(day.totals.requests, 4)
    assert.equal(day.byModel.find(m => m.model === 'claude-fable-5-1').input, 30)
    // Unchanged files are served from the cache; a grown file is re-read.
    const second = ledger.scan()
    assert.equal(second.events.length, 4)
    fs.appendFileSync(path.join(claudeDir, 'sess-1.jsonl'), '\n' + JSON.stringify({ type: 'assistant', timestamp: at(-1_000), cwd: `${rooms}/feather`, message: { id: 'c', model: 'claude-fable-5-1', usage: { input_tokens: 1, output_tokens: 1 } } }))
    assert.equal(ledger.scan().events.length, 5)
  })
})

describe('provider limits', () => {
  it('normalizes Anthropic usage windows and reads the OpenRouter key without exposing it', () => {
    assert.deepEqual(normalizeAnthropicUsage({ five_hour: { utilization: 0.42, resets_at: 1787708024 }, seven_day: { utilization: 12, resets_at: '2026-09-07T00:00:00Z' }, junk: 'x' }), [
      { name: 'five_hour', utilization: 0.42, resetsAt: '2026-08-26T01:33:44.000Z' },
      { name: 'seven_day', utilization: 12, resetsAt: '2026-09-07T00:00:00.000Z' },
    ])
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-keyvault-'))
    roots.push(root)
    const vault = path.join(root, 'keyvault.txt')
    fs.writeFileSync(vault, '# keys\nOPENAI=nope\nexport OPENROUTER_API_KEY="sk-or-test"\n')
    assert.equal(readOpenRouterKey({ keyvaultFile: vault, env: {} }), 'sk-or-test')
    assert.equal(readOpenRouterKey({ keyvaultFile: vault, env: { OPENROUTER_API_KEY: 'env-key' } }), 'env-key')
    assert.equal(readOpenRouterKey({ keyvaultFile: path.join(root, 'missing'), env: {} }), null)
  })

  it('polls providers at most once per interval and keeps the last good reading through a 429', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feather-limits-'))
    roots.push(root)
    const auth = path.join(root, 'auth.json')
    fs.writeFileSync(auth, JSON.stringify({ anthropic: { access: 'tok', expires: Date.now() + 1e9 }, 'openai-codex': { access: 'x', expires: 500 } }))
    const vault = path.join(root, 'keyvault.txt')
    fs.writeFileSync(vault, 'OPENROUTER_API_KEY=sk-or-test\n')
    let clock = 1_000_000
    const calls = []
    let anthropicStatus = 200
    const fetchImpl = async (url, { headers }) => {
      calls.push(url)
      assert.ok(!JSON.stringify(headers).includes('undefined'))
      if (url.includes('anthropic')) {
        return { ok: anthropicStatus === 200, status: anthropicStatus, text: async () => JSON.stringify(anthropicStatus === 200 ? { five_hour: { utilization: 0.3, resets_at: 1787708024 } } : { error: 'rate' }) }
      }
      if (url.endsWith('/credits')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: { total_credits: 20, total_usage: 9.3 } }) }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { usage_daily: 1.2, usage_weekly: 1.8, usage_monthly: 1.4, limit: null, limit_remaining: null } }) }
    }
    const limits = createProviderLimits({ ompAuthFile: auth, claudeCredentialsFile: path.join(root, 'none'), keyvaultFile: vault, fetchImpl, pollMs: 1000, now: () => clock, env: {} })
    const codexRateLimits = { at: Date.now(), primary: { used_percent: 3, window_minutes: 10080, resets_at: 1787708024 }, credits: { has_credits: false, unlimited: false, balance: '0' } }
    const first = await limits.snapshot({ codexRateLimits })
    assert.equal(first.anthropic.windows[0].utilization, 0.3)
    assert.equal(first.anthropic.error, null)
    assert.equal(first.openrouter.remaining, 20 - 9.3)
    assert.equal(first.openrouter.usageDaily, 1.2)
    assert.equal(first.codex.tokenExpired, true)
    assert.equal(first.codex.windows[0].name, '7d')
    assert.match(first.codex.error, /expired/)
    assert.equal(calls.length, 3)
    await limits.snapshot({ codexRateLimits })
    assert.equal(calls.length, 3, 'no refetch inside the poll interval')
    clock += 2000
    anthropicStatus = 429
    const third = await limits.snapshot({ codexRateLimits })
    assert.equal(calls.length, 6)
    assert.equal(third.anthropic.windows[0].utilization, 0.3, 'last good reading survives a 429')
    assert.match(third.anthropic.error, /rate-limiting/)
    assert.ok(!JSON.stringify(third).includes('tok') || JSON.stringify(third).includes('tokenSource'), 'no token in the snapshot')
    assert.ok(!JSON.stringify(third).includes('sk-or-test'))
  })
})
