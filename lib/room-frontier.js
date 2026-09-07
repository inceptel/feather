// FRONTIER.md helpers that the server and tests share. The frontier is the
// Leader's work queue; its Steering section belongs to the user, and this is
// the one code path that writes into it (the Steer box on a feed card and
// `room steer`). Everything else in the file is the agents' to move.

export const ROOM_STEER_MAX_CHARS = 2_000

// Normalizes the user's steer text: trims, collapses CRLF, rejects empty or
// oversized input. Throws a plain Error the caller maps to a 400.
export function normalizeSteerText(value) {
  if (typeof value !== 'string') throw new Error('steer text must be a string')
  const text = value.replace(/\r\n?/g, '\n').trim()
  if (!text) throw new Error('steer text is required')
  if ([...text].length > ROOM_STEER_MAX_CHARS) throw new Error(`steer text must be at most ${ROOM_STEER_MAX_CHARS} characters`)
  return text
}

// Returns the frontier text with one dated bullet appended to the end of the
// Steering section (before the next `## ` heading). A file without a Steering
// heading gets one right after its title so the line still lands where the
// agents look first. Continuation lines of a multi-line steer are indented so
// the bullet stays one list item.
export function appendSteering(frontierText, text, at = new Date()) {
  const stamp = at.toISOString().slice(0, 16).replace('T', ' ')
  const lines = String(text).split('\n')
  const bullet = [`- ${stamp} ${lines[0]}`, ...lines.slice(1).map((line) => `  ${line}`)].join('\n')
  const source = typeof frontierText === 'string' ? frontierText : ''
  const rows = source.split('\n')
  let start = rows.findIndex((row) => /^##\s+Steering\s*$/.test(row))
  if (start === -1) {
    const title = rows.findIndex((row) => /^#\s/.test(row))
    const insertAt = title === -1 ? 0 : title + 1
    rows.splice(insertAt, 0, '', '## Steering', '')
    start = insertAt + 1
  }
  let end = rows.length
  for (let i = start + 1; i < rows.length; i += 1) {
    if (/^##\s/.test(rows[i])) { end = i; break }
  }
  // Trim blank rows at the end of the section, append the bullet, restore one blank row.
  let last = end
  while (last > start + 1 && rows[last - 1].trim() === '') last -= 1
  const body = rows.slice(start + 1, last)
  const gap = body.length === 0 || !/^\s*[-*]/.test(body[body.length - 1]) ? [''] : []
  const rebuilt = [...rows.slice(0, start + 1), ...body, ...gap, bullet, '', ...rows.slice(end)]
  // The section had its own leading blank line; keep exactly one.
  return rebuilt.join('\n').replace(/^(## Steering\n)\n\n+/m, '$1\n')
}

// The wiki page a card's evidence id points at, or null. Evidence ids that
// name a page look like `wiki/PONS.md#anchor`; the page name is what
// /api/rooms/<room>/wiki/page?name= takes.
export function wikiPageFromEvidenceId(evidenceId) {
  const match = /^wiki\/(.+?)\.md(?:[#?].*)?$/.exec(String(evidenceId || '').trim())
  if (!match) return null
  const name = match[1]
  if (!/^[A-Za-z0-9][A-Za-z0-9 _./-]{0,159}$/.test(name)) return null
  if (name.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null
  return name
}
