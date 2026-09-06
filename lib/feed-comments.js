// Super Feed comments: a comment on a feed card goes to that Room's Leader
// as a tagged chat message. The Leader answers with `room reply <id> "..."`,
// which stores the reply on the comment record; the card shows that stored
// reply and nothing else. No transcript scraping.

export const FEED_COMMENT_PREFIX = '[Super Feed comment'
export const FEED_COMMENT_MAX_CHARS = 2_000
export const FEED_REPLY_MAX_CHARS = 8_000
export const FEED_COMMENTS_MAX = 500
export const FEED_COMMENT_ID_RE = /^[a-f0-9]{32}$/

function marker(commentId) {
  return `[feed-comment:${commentId}]`
}

// Delivery check: true when the Leader transcript holds the tagged prompt.
// Feather types the prompt into the Leader's tmux pane, and a busy or
// restarting agent can drop that paste (seen 2026-09-06). The server polls
// this a little later and re-sends once when the marker never landed.
export function commentDelivered(messages, commentId) {
  const tag = marker(commentId)
  const textOf = (content) => {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('\n')
    return ''
  }
  return (Array.isArray(messages) ? messages : []).some((message) => {
    const role = message?.role || message?.type
    if (role !== 'user' && role !== 'human') return false
    return textOf(message?.content).includes(tag)
  })
}

export function feedCommentPrompt({ commentId, roomName, item, text }) {
  const lines = [
    `${FEED_COMMENT_PREFIX} · #${roomName}] ${marker(commentId)}`,
    `The user commented on this Super Feed card from your Room:`,
    `  Card: ${item.title}`,
    ...(item.summary ? [`  Summary: ${String(item.summary).slice(0, 400)}`] : []),
    '',
    text,
    '',
    'Answer with exactly one command from your Room folder (the answer is shown under the card, so make it stand on its own):',
    `  room reply ${commentId} --stdin <<'REPLY'`,
    '  <your answer>',
    '  REPLY',
    'Chat text is not shown under the card; only that command is.',
  ]
  return lines.join('\n')
}

function isReply(value) {
  if (value === undefined || value === null) return true
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= FEED_REPLY_MAX_CHARS
    && typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp))
}

export function isFeedCommentState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!Array.isArray(value.comments)) return false
  return value.comments.every(comment => comment && typeof comment === 'object' && !Array.isArray(comment)
    && typeof comment.id === 'string' && FEED_COMMENT_ID_RE.test(comment.id)
    && typeof comment.evidenceId === 'string' && comment.evidenceId.length > 0 && comment.evidenceId.length <= 500
    && typeof comment.room === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(comment.room)
    && typeof comment.text === 'string' && comment.text.length > 0 && comment.text.length <= FEED_COMMENT_MAX_CHARS
    && typeof comment.createdAt === 'string' && Number.isFinite(Date.parse(comment.createdAt))
    && typeof comment.leaderSessionId === 'string' && comment.leaderSessionId.length > 0
    && isReply(comment.reply))
}

export function normalizeFeedCommentText(value, { max = FEED_COMMENT_MAX_CHARS, label = 'comment' } = {}) {
  if (typeof value !== 'string') return null
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (!text) return null
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters`)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error(`${label} contains control characters`)
  return text
}

export function normalizeFeedReplyText(value) {
  return normalizeFeedCommentText(value, { max: FEED_REPLY_MAX_CHARS, label: 'reply' })
}

// What the feed shows for a stored comment: no Leader session id, and the
// reply exactly as stored (null while the Room has not answered yet).
export function publicFeedComment(comment) {
  return {
    id: comment.id,
    evidenceId: comment.evidenceId,
    room: comment.room,
    text: comment.text,
    createdAt: comment.createdAt,
    reply: comment.reply ? { text: comment.reply.text, timestamp: comment.reply.timestamp } : null,
  }
}
