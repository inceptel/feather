import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  FEED_COMMENT_MAX_CHARS, FEED_COMMENT_PREFIX, FEED_REPLY_MAX_CHARS,
  commentDelivered, feedCommentPrompt, feedReplyNudgePrompt, isFeedCommentState, normalizeFeedCommentText, normalizeFeedReplyText, publicFeedComment,
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
    assert.ok(prompt.includes(`room reply ${ID} --stdin`))
    assert.ok(prompt.includes('Reply FIRST'))
    const nudge = feedReplyNudgePrompt({ commentId: ID, roomName: 'ev-shop', text: 'How many bays?' })
    assert.ok(nudge.startsWith(`${FEED_COMMENT_PREFIX} reminder · #ev-shop] [feed-comment:${ID}]\n`))
    assert.ok(nudge.includes(`room reply ${ID} --stdin`))
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
    assert.equal(isFeedCommentState({ comments: [comment({ reply: null })] }), true)
    assert.equal(isFeedCommentState({ comments: [comment({ reply: { text: 'Eleven bays.', timestamp: '2026-09-06T12:01:00.000Z' } })] }), true)
    assert.equal(isFeedCommentState({ comments: [comment({ reply: { text: '', timestamp: '2026-09-06T12:01:00.000Z' } })] }), false)
    assert.equal(isFeedCommentState({ comments: [comment({ reply: { text: 'x', timestamp: 'later' } })] }), false)
  })

  it('normalizes comment text and rejects junk', () => {
    assert.equal(normalizeFeedCommentText('  hi\r\nthere  '), 'hi\nthere')
    assert.equal(normalizeFeedCommentText('   '), null)
    assert.equal(normalizeFeedCommentText(null), null)
    assert.throws(() => normalizeFeedCommentText('x'.repeat(FEED_COMMENT_MAX_CHARS + 1)), /exceeds/)
    assert.throws(() => normalizeFeedCommentText('a\x00b'), /control characters/)
  })

  it('accepts long replies but not junk', () => {
    assert.equal(normalizeFeedReplyText('  answer\r\n'), 'answer')
    assert.equal(normalizeFeedReplyText('x'.repeat(FEED_REPLY_MAX_CHARS)).length, FEED_REPLY_MAX_CHARS)
    assert.throws(() => normalizeFeedReplyText('x'.repeat(FEED_REPLY_MAX_CHARS + 1)), /reply exceeds/)
  })

  it('exposes the stored reply and hides the Leader session', () => {
    const answered = publicFeedComment(comment({ reply: { text: 'Eleven bays, per the listing.', timestamp: '2026-09-06T12:01:00Z', extra: 'hidden' } }))
    assert.deepEqual(answered.reply, { text: 'Eleven bays, per the listing.', timestamp: '2026-09-06T12:01:00Z' })
    assert.ok(!('leaderSessionId' in answered))
    assert.equal(publicFeedComment(comment()).reply, null)
  })
})

it('commentDelivered finds the tagged prompt only in user turns', () => {
  const tag = `[feed-comment:${ID}]`
  assert.equal(commentDelivered([], ID), false)
  assert.equal(commentDelivered([{ role: 'assistant', content: `echo ${tag}` }], ID), false)
  assert.equal(commentDelivered([{ role: 'user', content: `[Super Feed comment · #x] ${tag}\nhi` }], ID), true)
  assert.equal(commentDelivered([{ role: 'user', content: [{ type: 'text', text: `${tag} hi` }] }], ID), true)
  assert.equal(commentDelivered([{ role: 'user', content: '[feed-comment:0000] other' }], ID), false)
})

describe('house replyguy queue line', () => {
  it('packs the comment, card, and evidence into one open line', async () => {
    const { feedCommentQueueLine } = await import('../../lib/feed-comments.js')
    const line = feedCommentQueueLine({
      commentId: 'ab'.repeat(16), roomName: 'trading', at: new Date('2026-09-07T23:03:00Z'),
      item: { title: 'The "breakout" strategy\ndoes not hold up', evidenceId: 'publication:trading:breakout' },
      text: 'why\n   no go?',
    })
    assert.equal(line, `- open ${'ab'.repeat(16)} #trading 2026-09-07 23:03 card="The 'breakout' strategy does not hold up" evidence=publication:trading:breakout :: why no go?`)
  })
})
