import { createHash } from 'crypto'

const MAX_FEED_ITEMS = 200
const MAX_COMPLAINT_SUMMARY_LENGTH = 600
const MAX_COMPLAINT_EVIDENCE_LENGTH = 1_200

function timestampMs(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}

function boundedText(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : null
}

function sourceHrefForSession(sessionId) {
  return `/#${encodeURIComponent(sessionId)}`
}

export function buildSuperFeed({ rooms = [], complaints = [] } = {}) {
  const items = []

  for (const room of rooms) {
    // Only canonical user-facing Leader chat text may leave the server.
    // notes.md fallbacks, legacy Updates, Sidecar, and tool activity are not
    // feed sources even when another endpoint uses them for internal sorting.
    const fallback = room.latest
      && (room.latest.role === 'user' || room.latest.role === 'assistant')
      ? [room.latest]
      : []
    const messages = Array.isArray(room.feedMessages) ? room.feedMessages : fallback
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      const occurredAt = message.timestamp || room.updatedAt
      if (!room.leaderSessionId || !occurredAt || !message.text) continue
      const messageIdentity = message.id || occurredAt
      const evidenceId = `message:${room.leaderSessionId}:${messageIdentity}`
      items.push({
        evidenceId,
        kind: 'update',
        room: room.name,
        title: `#${room.name}`,
        summary: message.text,
        detail: null,
        occurredAt,
        sourceHref: sourceHrefForSession(room.leaderSessionId),
        sourceState: 'available',
        status: room.active && index === messages.length - 1 ? 'working' : message.role === 'user' ? 'asked' : 'updated',
        needsReview: false,
        sessionId: room.leaderSessionId,
      })
    }

    if (room.pulse?.status === 'error' && room.leaderSessionId) {
      const occurredAt = room.pulse.lastRunAt || room.updatedAt
      const evidenceId = `room:${room.name}:pulse:${occurredAt || 'current'}`
      items.push({
        evidenceId,
        kind: 'alert',
        room: room.name,
        title: `#${room.name} status failed`,
        summary: room.pulse.error || 'The Room status check failed.',
        detail: 'Open the Room to retry or investigate.',
        occurredAt,
        sourceHref: sourceHrefForSession(room.leaderSessionId),
        sourceState: 'available',
        status: 'needs review',
        needsReview: true,
        sessionId: room.leaderSessionId,
      })
    }
  }

  for (const complaint of complaints) {
    if (!complaint.hasStableId) continue
    const evidenceId = `friction:${complaint.id}`
    items.push({
      evidenceId,
      kind: 'friction',
      room: complaint.source,
      title: `#${complaint.source} → #friction`,
      summary: boundedText(complaint.summary, MAX_COMPLAINT_SUMMARY_LENGTH),
      detail: boundedText(complaint.evidence, MAX_COMPLAINT_EVIDENCE_LENGTH),
      occurredAt: complaint.timestamp,
      sourceHref: `/api/rooms/${encodeURIComponent(complaint.source)}/friction#${encodeURIComponent(complaint.id)}`,
      sourceState: rooms.some(room => room.name === complaint.source) ? 'available' : 'stale',
      status: null,
      needsReview: false,
      sessionId: null,
      complaintId: complaint.id,
    })
  }

  return items
    .sort((left, right) => timestampMs(right.occurredAt) - timestampMs(left.occurredAt)
      || left.evidenceId.localeCompare(right.evidenceId))
    .slice(0, MAX_FEED_ITEMS)
}

export function mergeSuperFeed(previousItems, currentItems, rooms) {
  const current = new Map(currentItems.map(item => [item.evidenceId, item]))
  const roomNames = new Set(rooms.map(room => room.name))
  const sessionIds = new Set(rooms.flatMap(room => room.sessions.map(session => session.id)))
  for (const previous of previousItems) {
    if (current.has(previous.evidenceId)) continue
    if (previous.kind === 'alert' && roomNames.has(previous.room)) continue
    const available = previous.kind === 'friction'
      ? roomNames.has(previous.room)
      : Boolean(previous.sessionId && sessionIds.has(previous.sessionId))
    current.set(previous.evidenceId, {
      ...previous,
      sourceState: available ? 'available' : 'stale',
    })
  }
  return [...current.values()]
    .sort((left, right) => timestampMs(right.occurredAt) - timestampMs(left.occurredAt)
      || left.evidenceId.localeCompare(right.evidenceId))
    .slice(0, MAX_FEED_ITEMS)
}

export function superFeedCursor(items) {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 24)
}
