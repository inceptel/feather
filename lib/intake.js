// The Intake Room is a front door rather than an autonomous staffed Room.
// Its current conversation is therefore the cross-Room delivery target when it
// intentionally has no Leader designation.
export const INTAKE_ROOM = 'intake'

// Legacy status reporters and wake chats are machinery, not the front door.
const MACHINERY_TITLE_RE = /^(Keep working|Status): #/

export function pickIntakeSession(sessions, { skipIds = [] } = {}) {
  const skip = new Set(skipIds.filter(Boolean))
  const list = Array.isArray(sessions)
    ? sessions.filter((session) => session && session.id && !skip.has(session.id) && !MACHINERY_TITLE_RE.test(String(session.title || '')))
    : []
  if (list.length === 0) return null
  const byNewest = [...list].sort((a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0))
  return byNewest.find((session) => session.isActive) || byNewest[0]
}
