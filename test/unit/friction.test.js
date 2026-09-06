import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrictionNotes, openFrictionComplaints } from '../../lib/friction.js'

describe('parseFrictionNotes', () => {
  it('extracts structured and legacy complaints while ignoring room commentary', () => {
    const notes = [
      '# #friction — notes',
      '- 2026-08-23 12:00 [id:abc123] Complaint from #feather: Browser stalled | Evidence: pthread unavailable',
      '- 2026-08-23 12:01 ROUTED this is triage commentary',
      '- 2026-08-23 12:02 Complaint from #health: Calendar login loop',
    ].join('\n')
    assert.deepEqual(parseFrictionNotes(notes), [
      {
        id: 'abc123', timestamp: '2026-08-23T12:00:00Z', source: 'feather',
        hasStableId: true,
        summary: 'Browser stalled', evidence: 'pthread unavailable',
        resolvedAt: null, resolution: null,
      },
      {
        id: 'legacy-0', timestamp: '2026-08-23T12:02:00Z', source: 'health',
        hasStableId: false,
        summary: 'Calendar login loop', evidence: null,
        resolvedAt: null, resolution: null,
      },
    ])
  })

  it('enforces the supported complaint id and Room source bounds', () => {
    const maxId = 'i'.repeat(128)
    const maxSource = 's'.repeat(64)
    const complaints = parseFrictionNotes([
      `- 2026-08-23 12:00 [id:${maxId}] Complaint from #feather: Max id`,
      `- 2026-08-23 12:01 [id:source-bound] Complaint from #${maxSource}: Max source`,
      `- 2026-08-23 12:02 [id:${'i'.repeat(129)}] Complaint from #feather: Oversized id`,
      `- 2026-08-23 12:03 [id:source-too-long] Complaint from #${'s'.repeat(65)}: Oversized source`,
    ].join('\n'))

    assert.deepEqual(complaints.map(complaint => complaint.id), [maxId, 'source-bound'])
    assert.deepEqual(complaints.map(complaint => complaint.source), ['feather', maxSource])
  })

  it('returns an empty list for absent or unrelated notes', () => {
    assert.deepEqual(parseFrictionNotes(''), [])
    assert.deepEqual(parseFrictionNotes('- 2026-08-23 12:00 fixed something'), [])
  })

  it('closes a complaint when a later [resolved:<id>] line names it', () => {
    const notes = [
      '- 2026-09-01 10:00 [id:slow-feed] Complaint from #feather: Feed takes 8s | Evidence: /api/feed 8.1s',
      '- 2026-09-01 10:05 [id:open-one] Complaint from #hoa: Calendar sync loops',
      '- 2026-09-02 09:00 [resolved:slow-feed] Cached the snapshot; /api/feed now 40ms',
      '- 2026-09-02 09:01 [resolved:never-filed] Nothing to close',
      '- 2026-09-03 09:00 [resolved:slow-feed] duplicate resolution is ignored',
    ].join('\n')
    const complaints = parseFrictionNotes(notes)
    assert.equal(complaints.length, 2)
    assert.equal(complaints[0].resolvedAt, '2026-09-02T09:00:00Z')
    assert.equal(complaints[0].resolution, 'Cached the snapshot; /api/feed now 40ms')
    assert.equal(complaints[1].resolvedAt, null)
    assert.deepEqual(openFrictionComplaints(complaints).map(complaint => complaint.id), ['open-one'])
  })
})
