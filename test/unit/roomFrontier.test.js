import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appendSteering, normalizeSteerText, wikiPageFromEvidenceId, ROOM_STEER_MAX_CHARS } from '../../lib/room-frontier.js'
import { frontierTemplate } from '../../lib/room-template.js'

const AT = new Date('2026-09-07T10:05:00Z')

describe('FRONTIER.md steering', () => {
  it('appends a dated bullet at the end of the Steering section of a template frontier', () => {
    const next = appendSteering(frontierTemplate('ev-shop'), 'Price the equipment before the lease.', AT)
    assert.match(next, /## Steering\n\n<!-- The user writes here[^\n]*-->\n\n- 2026-09-07 10:05 Price the equipment before the lease\.\n\n## Open\n/)
    // A second steer lands under the first, still inside Steering.
    const again = appendSteering(next, 'No purchases.', new Date('2026-09-07T11:00:00Z'))
    assert.match(again, /- 2026-09-07 10:05 Price the equipment before the lease\.\n- 2026-09-07 11:00 No purchases\.\n\n## Open\n/)
    assert.equal(again.split('## Steering').length, 2)
  })

  it('keeps a multi-line steer as one list item and creates Steering when it is missing', () => {
    const next = appendSteering('# Frontier — #x\n\n## Open\n\n- a gap\n', 'First line\nsecond line', AT)
    assert.equal(next, '# Frontier — #x\n\n## Steering\n\n- 2026-09-07 10:05 First line\n  second line\n\n## Open\n\n- a gap\n')
  })

  it('normalizes steer text and rejects empty or oversized input', () => {
    assert.equal(normalizeSteerText('  do this\r\nthen that  '), 'do this\nthen that')
    assert.throws(() => normalizeSteerText('   '), /required/)
    assert.throws(() => normalizeSteerText(42), /string/)
    assert.throws(() => normalizeSteerText('x'.repeat(ROOM_STEER_MAX_CHARS + 1)), /at most/)
  })

  it('reads the wiki page out of an evidence id, and nothing out of anything else', () => {
    assert.equal(wikiPageFromEvidenceId('wiki/Robinhood-Chain.md#2026-09-06-managed-data'), 'Robinhood-Chain')
    assert.equal(wikiPageFromEvidenceId('wiki/Operations.md'), 'Operations')
    assert.equal(wikiPageFromEvidenceId('wiki/deep/Page Name.md#a'), 'deep/Page Name')
    assert.equal(wikiPageFromEvidenceId('notes.md#2026-09-07T05:46-indexer'), null)
    assert.equal(wikiPageFromEvidenceId('sidecar://room-trading/189'), null)
    assert.equal(wikiPageFromEvidenceId('wiki/../secrets.md'), null)
    assert.equal(wikiPageFromEvidenceId(''), null)
    assert.equal(wikiPageFromEvidenceId(undefined), null)
  })
})
