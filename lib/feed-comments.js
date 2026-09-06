// Super Feed comments: a comment on a feed card goes to that Room's Leader
// as a tagged chat message, and the Leader's next answer is shown under the
// card. The comment store only remembers what was sent; the reply is read
// back from the Leader transcript so the chat stays the single source.

export const FEED_COMMENT_PREFIX = '[Super Feed comment'
export const FEED_COMMENT_MAX_CHARS = 2_000
export const FEED_COMMENTS_MAX = 500
export const FEED_COMMENT_ID_RE = /^[a-f0-9]{32}$/

function marker(commentId) {
  return `[feed-comment:${commentId}]`
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
    'Answer in this chat. Your next reply is shown under the card in the Super Feed, so make it stand on its own.',
  ]
  return lines.join('\n')
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
    && typeof comment.leaderSessionId === 'string' && comment.leaderSessionId.length > 0)
}

export function normalizeFeedCommentText(value) {
  if (typeof value !== 'string') return null
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (!text) return null
  if (text.length > FEED_COMMENT_MAX_CHARS) throw new Error(`comment exceeds ${FEED_COMMENT_MAX_CHARS} characters`)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('comment contains control characters')
  return text
}

// messages: Leader transcript in order, each {role, text, timestamp}.
// Returns the comments with their reply (the first assistant text after the
// tagged user message) or null while the Leader is still answering.
export function feedCommentReplies(comments, messages) {
  return comments.map(comment => {
    const tag = marker(comment.id)
    const index = messages.findIndex(message => message.role === 'user' && typeof message.text === 'string' && message.text.includes(tag))
    let reply = null
    if (index >= 0) {
      const answer = messages.slice(index + 1).find(message => message.role === 'assistant' && message.text)
      if (answer) reply = { text: answer.text, timestamp: answer.timestamp || null }
    }
    return {
      id: comment.id,
      evidenceId: comment.evidenceId,
      room: comment.room,
      text: comment.text,
      createdAt: comment.createdAt,
      delivered: index >= 0,
      reply,
    }
  })
}
