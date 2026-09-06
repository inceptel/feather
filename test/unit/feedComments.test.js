import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  FEED_COMMENT_MAX_CHARS, FEED_COMMENT_PREFIX,
  feedCommentPrompt, feedCommentReplies, isFeedCommentState, normalizeFeedCommentText,
} from '../../lib/feed-comments.js'

const ID = 'a'.repeat(32)
const comment = (overrides = {}) => ({
  id: ID, evidenceId: 'ev-shop:plan-2026-09-06', room: 'ev-shop', text: 'How many bays?',
  createdAt: '2026-09-06T12:00:00.000Z', leaderSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ...overrides,
})

describe('Super Feed comments', () => {
  it('builds a tagged Leader prompt that carries the card and the comment', () => {
    const prompt = feedCommentPrompt({ commentId: ID, roomName: 'ev-shop', item: { title: 'EV shop plan', summary: 'S'.repeat(500) }, text: 'How many bays?' })
    assert.ok(prompt.startsWith(`${FEED_COMMENT_PREFIX} · #ev-shop] [feed-comment:${ID}]\n`))
    assert.ok(prompt.includes('  Card: EV shop plan'))
    assert.ok(prompt.includes(`  Summary: ${'S'.repeat(400)}\n`))
    assert.ok(prompt.includes('\nHow many bays?\n'))
    assert.ok(prompt.includes('shown under the card'))
  })

  it('validates the stored comment document', () => {
    assert.equal(isFeedCommentState({ comments: [] }), true)
    assert.equal(isFeedCommentState({ comments: [comment()] }), true)
    assert.equal(isFeedCommentState({}), false)
    assert.equal(isFeedCommentState([]), false)
    assert.equal(isFeedCommentState({ comments: [comment({ id: 'short' })] }), false)
    assert.equal(isFeedCommentState({ comments: [comment({ room: 'Bad Room' })] }), false)
    assert.equal(isFeedCommentState({ comments: [comment({ text: '' })] }), false)
    assert.equal(isFeedCommentState({ comments: [comment({ createdAt: 'yesterday' })] }), false)
    assert.equal(isFeedCommentState({ comments: [comment({ leaderSessionId: '' })] }), false)
  })

  it('normalizes comment text and rejects junk', () => {
    assert.equal(normalizeFeedCommentText('  hi\r\nthere  '), 'hi\nthere')
    assert.equal(normalizeFeedCommentText('   '), null)
    assert.equal(normalizeFeedCommentText(null), null)
    assert.throws(() => normalizeFeedCommentText('x'.repeat(FEED_COMMENT_MAX_CHARS + 1)), /exceeds/)
    assert.throws(() => normalizeFeedCommentText('a\x00b'), /control characters/)
  })

  it('reads each reply from the Leader transcript after the tagged message', () => {
    const other = 'c'.repeat(32)
    const messages = [
      { role: 'assistant', text: 'Earlier answer', timestamp: '2026-09-06T11:00:00Z' },
      { role: 'user', text: feedCommentPrompt({ commentId: ID, roomName: 'ev-shop', item: { title: 'T' }, text: 'How many bays?' }), timestamp: '2026-09-06T12:00:00Z' },
      { role: 'assistant', text: '', timestamp: '2026-09-06T12:00:30Z' },
      { role: 'assistant', text: 'Eleven bays, per the listing.', timestamp: '2026-09-06T12:01:00Z' },
      { role: 'user', text: feedCommentPrompt({ commentId: other, roomName: 'ev-shop', item: { title: 'T' }, text: 'Rent?' }), timestamp: '2026-09-06T12:02:00Z' },
    ]
    const replies = feedCommentReplies([comment(), comment({ id: other, text: 'Rent?' }), comment({ id: 'd'.repeat(32), text: 'lost' })], messages)
    assert.equal(replies[0].delivered, true)
    assert.deepEqual(replies[0].reply, { text: 'Eleven bays, per the listing.', timestamp: '2026-09-06T12:01:00Z' })
    assert.equal(replies[1].delivered, true)
    assert.equal(replies[1].reply, null)
    assert.equal(replies[2].delivered, false)
    assert.equal(replies[2].reply, null)
    assert.ok(!('leaderSessionId' in replies[0]))
  })
})
