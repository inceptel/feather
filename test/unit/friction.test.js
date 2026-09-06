import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrictionNotes } from '../../lib/friction.js'

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
      },
      {
        id: 'legacy-0', timestamp: '2026-08-23T12:02:00Z', source: 'health',
        hasStableId: false,
        summary: 'Calendar login loop', evidence: null,
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
})
