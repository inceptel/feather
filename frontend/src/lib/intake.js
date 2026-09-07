// The Intake chat is the one front door: a chat in ~/rooms/intake that files
// requests into Rooms. "Continue" reopens the newest intake chat (a live one
// wins); "New" starts a fresh chat in the same folder.
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
