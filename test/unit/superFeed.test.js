import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildSuperFeed, mergeSuperFeed, superFeedCursor } from '../../lib/super-feed.js'
import { parseFrictionNotes } from '../../lib/friction.js'

describe('Super Feed projection', () => {
  it('orders Room outcomes, failures, and friction in one stable timeline', () => {
    const items = buildSuperFeed({
      rooms: [{
        name: 'trading', active: true, leaderSessionId: 'leader-1', updatedAt: '2026-09-05T12:00:00Z',
        latest: { role: 'assistant', text: 'Risk check completed.' },
        pulse: { status: 'working', lastRunAt: '2026-09-05T11:59:00Z' },
      }, {
        name: 'health', active: false, leaderSessionId: 'leader-2', updatedAt: '2026-09-05T11:00:00Z',
        latest: { role: 'assistant', text: 'Waiting on calendar access.' },
        pulse: { status: 'error', error: 'Calendar token expired', lastRunAt: '2026-09-05T12:30:00Z' },
      }],
      complaints: [{
        id: 'calendar-auth', hasStableId: true, source: 'health', timestamp: '2026-09-05T13:00:00Z',
        summary: 'Calendar auth repeatedly expires.', evidence: '401 from provider',
      }],
    })

    assert.deepEqual(items.map(item => [item.kind, item.room]), [
      ['friction', 'health'],
      ['alert', 'health'],
      ['update', 'trading'],
      ['update', 'health'],
    ])
    assert.equal(items[0].complaintId, 'calendar-auth')
    assert.equal(items[0].needsReview, false)
    assert.equal(items[1].summary, 'Calendar token expired')
    assert.equal(items[2].sessionId, 'leader-1')
    assert.equal(items[2].status, 'working')
    assert.equal(items[0].status, null, 'complaint resolution is unknown without canonical evidence')
    assert.equal(items[2].sourceHref, '/#leader-1')
    assert.equal(superFeedCursor(items), superFeedCursor(items))
  })

  it('does not expose empty Rooms as fake updates', () => {
    assert.deepEqual(buildSuperFeed({
      rooms: [{ name: 'new-room', latest: null, updatedAt: null, pulse: { status: 'waiting' } }],
      complaints: [],
    }), [])
  })

  it('uses deterministic evidence identity and excludes non-user-facing Room evidence', () => {
    const occurredAt = '2026-09-05T12:00:00Z'
    const items = buildSuperFeed({
      rooms: [{
        name: 'notes-only', leaderSessionId: null, updatedAt: occurredAt,
        latest: { role: 'notes', text: 'PRIVATE RAW NOTE' }, pulse: { status: 'waiting' },
      }, {
        name: 'zeta', leaderSessionId: 'leader-z', updatedAt: occurredAt, active: false,
        latest: { role: 'assistant', text: 'Z outcome' }, pulse: { status: 'waiting' },
      }, {
        name: 'alpha', leaderSessionId: 'leader-a', updatedAt: occurredAt, active: false,
        latest: { role: 'assistant', text: 'A outcome' }, pulse: { status: 'waiting' },
      }],
    })

    assert.deepEqual(items.map(item => item.evidenceId), [
      `message:leader-a:${occurredAt}`,
      `message:leader-z:${occurredAt}`,
    ])
    assert.equal(JSON.stringify(items).includes('PRIVATE RAW NOTE'), false)
  })

  it('retains an exact locator and marks it stale when its source disappears', () => {
    const previous = buildSuperFeed({
      rooms: [{
        name: 'old-room', leaderSessionId: 'old-leader', updatedAt: '2026-09-05T12:00:00Z', active: false,
        latest: { role: 'assistant', text: 'Historical outcome' }, pulse: { status: 'waiting' }, sessions: [{ id: 'old-leader' }],
      }],
    })
    const merged = mergeSuperFeed(previous, [], [])

    assert.equal(merged[0].sourceHref, '/#old-leader')
    assert.equal(merged[0].sourceState, 'stale')
    assert.equal(merged[0].summary, 'Historical outcome')
  })

  it('publishes only explicitly keyed friction records', () => {
    const complaints = parseFrictionNotes([
      '- 2026-09-05 23:17 Complaint from #x-bookmarks: --stdin',
      '- 2026-09-05 23:20 Complaint from #feather: --stdin',
      '- 2026-09-05 23:20 Complaint from #x-bookmarks: --stdin',
      '- 2026-09-05 23:21 [id:real-complaint] Complaint from #feather: Durable failure',
    ].join('\n'))
    const items = buildSuperFeed({
      rooms: [{ name: 'feather' }, { name: 'x-bookmarks' }],
      complaints,
    })

    assert.deepEqual(items.map(item => item.evidenceId), ['friction:real-complaint'])
    assert.equal(JSON.stringify(items).includes('--stdin'), false)
  })

  it('marks a resolved complaint instead of dropping it', () => {
    const complaints = parseFrictionNotes([
      '- 2026-09-05 23:21 [id:slow-feed] Complaint from #feather: Feed is slow',
      '- 2026-09-06 08:00 [resolved:slow-feed] Cached the snapshot',
    ].join('\n'))
    const [item] = buildSuperFeed({ rooms: [{ name: 'feather' }], complaints })
    assert.equal(item.status, 'resolved')
    assert.equal(item.resolvedAt, '2026-09-06T08:00:00Z')
    assert.equal(item.resolution, 'Cached the snapshot')
    // The card keeps its place in the timeline (when it was filed).
    assert.equal(item.occurredAt, '2026-09-05T23:21:00Z')
  })

  it('removes a recovered pulse failure from Review', () => {
    const failedRoom = {
      name: 'health', leaderSessionId: 'leader-health', updatedAt: '2026-09-05T12:00:00Z',
      latest: null, sessions: [{ id: 'leader-health' }],
      pulse: { status: 'error', error: 'Calendar token expired', lastRunAt: '2026-09-05T12:30:00Z' },
    }
    const recoveredRoom = {
      ...failedRoom,
      pulse: { status: 'waiting', lastRunAt: '2026-09-05T12:31:00Z' },
    }
    const previous = buildSuperFeed({ rooms: [failedRoom] })
    const current = buildSuperFeed({ rooms: [recoveredRoom] })
    const merged = mergeSuperFeed(previous, current, [recoveredRoom])

    assert.equal(merged.some(item => item.kind === 'alert'), false)
    assert.equal(merged.some(item => item.needsReview), false)
  })

  it('removes a pulse failure when its Room is deleted', () => {
    const previous = buildSuperFeed({
      rooms: [{
        name: 'deleted', leaderSessionId: 'leader-deleted', updatedAt: '2026-09-05T12:00:00Z',
        latest: null, sessions: [{ id: 'leader-deleted' }],
        pulse: { status: 'error', error: 'Room check failed', lastRunAt: '2026-09-05T12:30:00Z' },
      }],
    })
    const merged = mergeSuperFeed(previous, [], [])

    assert.equal(merged.some(item => item.kind === 'alert'), false)
    assert.equal(merged.some(item => item.needsReview), false)
  })

  it('bounds complaint fields by Unicode code point without splitting a surrogate', () => {
    const [item] = buildSuperFeed({
      rooms: [{ name: 'health' }],
      complaints: [{
        id: 'oversized', hasStableId: true, source: 'health', timestamp: '2026-09-05T13:00:00Z',
        summary: '😀'.repeat(601), evidence: 'e'.repeat(1_201),
      }],
    })

    assert.equal(item.summary, '😀'.repeat(600))
    assert.equal(item.detail, 'e'.repeat(1_200))
  })

  it('projects selected Room publications with their verified visual locator', () => {
    const [item] = buildSuperFeed({
      rooms: [{ name: 'jacksonville-ev' }],
      publications: [{
        room: 'jacksonville-ev',
        id: 'jax-ev-0001',
        title: 'Jacksonville charging signal',
        summary: 'A local change now affects EV planning.',
        detail: 'Primary evidence checked.',
        occurredAt: '2026-09-06T14:00:00Z',
        visualHref: '/api/rooms/jacksonville-ev/publications/jax-ev-0001/visual',
        visualAlt: 'A map-style Jacksonville EV briefing.',
      }],
    })

    assert.equal(item.evidenceId, 'publication:jacksonville-ev:jax-ev-0001')
    assert.equal(item.title, '#jacksonville-ev · Jacksonville charging signal')
    assert.equal(item.status, 'briefing')
    assert.equal(item.sessionId, null)
    assert.equal(item.visualHref, '/api/rooms/jacksonville-ev/publications/jax-ev-0001/visual')
    assert.equal(item.visualAlt, 'A map-style Jacksonville EV briefing.')

    const [stale] = mergeSuperFeed([item], [], [])
    assert.equal(stale.sourceState, 'stale')
  })
  it('projects By-the-way publications without review attention or a visual', () => {
    const [item] = buildSuperFeed({
      rooms: [{ name: 'ev-shop' }],
      publications: [{
        room: 'ev-shop',
        id: 'competitor-context',
        sourceEvidenceId: 'wiki/Competition.md#2026-09-06',
        attention: 'by-the-way',
        title: 'Nearby hybrid shop opened',
        summary: 'Useful local context; no action is requested.',
        occurredAt: '2026-09-06T15:00:00Z',
      }],
    })

    assert.equal(item.attention, 'by-the-way')
    assert.equal(item.status, 'by the way')
    assert.equal(item.needsReview, false)
    assert.equal(item.visualHref, undefined)
  })

})
