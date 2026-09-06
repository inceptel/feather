const URL_RE = /https?:\/\/[^\s<>"']+/gu
const TRAILING_PUNCTUATION_RE = /[),.;!?\]}]+$/u

const ROOM_KEYWORDS = Object.freeze([
  ['trading', /\b(robinhood|trading|crypto|market|portfolio|stock|token)\b/iu],
  ['space', /\b(space|rocket|launch|satellite|spacex)\b/iu],
  ['wealth', /\b(wealth|finance|financial|tax|investment)\b/iu],
  ['boat', /\b(boat|marine|sailing|yacht)\b/iu],
  ['health', /\b(health|medical|medicine|fitness)\b/iu],
  ['feather', /\b(feather|fledge|agent|ai|llm|claude|codex|astra|fable|council|skill|codebase)\b/iu],
])

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`bookmark ${field} is missing`)
  return value.trim()
}

function cleanUrl(raw) {
  return raw.replace(TRAILING_PUNCTUATION_RE, '')
}

export function extractUrls(text) {
  return [...new Set((String(text).match(URL_RE) || []).map(cleanUrl))].slice(0, 5)
}

export function normalizeBookmark(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('bookmark is not an object')
  const id = requiredString(raw.id, 'id')
  if (!/^\d{8,24}$/u.test(id)) throw new Error(`bookmark id is invalid: ${id}`)
  const text = requiredString(raw.text, 'text')
  const createdAt = requiredString(raw.createdAt, 'createdAt')
  const username = requiredString(raw.author?.username, 'author.username')
  return {
    id,
    text,
    createdAt,
    author: { username, name: typeof raw.author?.name === 'string' ? raw.author.name.trim() : '' },
    sourceUrl: `https://x.com/${encodeURIComponent(username)}/status/${id}`,
    canonicalUrls: extractUrls(text),
  }
}

export async function expandShortUrls(bookmark, resolveUrl) {
  const canonicalUrls = []
  for (const url of bookmark.canonicalUrls) {
    let resolved = url
    if (new URL(url).hostname.toLowerCase() === 't.co') {
      try { resolved = await resolveUrl(url) } catch {}
    }
    if (!canonicalUrls.includes(resolved)) canonicalUrls.push(resolved)
  }
  return { ...bookmark, canonicalUrls }
}

export function classifyBookmark(bookmark, { roomExists = () => true, skillCollision = false } = {}) {
  const haystack = `${bookmark.text} ${bookmark.canonicalUrls.join(' ')}`
  const githubRepository = bookmark.canonicalUrls.find((url) => {
    try {
      const parsed = new URL(url)
      return parsed.hostname.toLowerCase() === 'github.com' && parsed.pathname.split('/').filter(Boolean).length >= 2
    } catch { return false }
  }) || null
  const skillCandidate = /\bskill\b/iu.test(haystack) || /github\.com\/[^/]+\/(?:[^/?#]*skill[^/?#]*|council)(?:[/?#]|$)/iu.test(haystack)
  let room = 'feather'
  for (const [candidate, pattern] of ROOM_KEYWORDS) {
    if (pattern.test(haystack) && roomExists(candidate)) { room = candidate; break }
  }
  if (!roomExists(room)) room = 'feather'

  return {
    kind: skillCandidate ? 'skill-candidate' : githubRepository ? 'code-reference' : 'reference',
    disposition: 'review-required',
    room,
    githubRepository,
    collision: Boolean(skillCandidate && skillCollision),
    rationale: skillCandidate
      ? (skillCollision
          ? 'An installed capability has the same name; preserve it and review this immutable external source without installing or executing it.'
          : 'External skills are untrusted code/configuration and require immutable-source review plus explicit human approval before governed installation.')
      : 'A bookmark does not encode execution intent; preserve it as evidence and route it for review.',
  }
}

function idGreaterThan(left, right) {
  return BigInt(left) > BigInt(right)
}

export function selectUnseen(bookmarks, cursorId, limit = 20) {
  const ordered = [...bookmarks].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)
  if (!cursorId) return ordered.length ? [ordered.at(-1)] : []
  return ordered.filter((bookmark) => idGreaterThan(bookmark.id, cursorId)).slice(0, limit)
}

export function noteMarker(id) {
  return `[X bookmark ${id}]`
}

export function reviewNote(item) {
  const urls = item.canonicalUrls.length ? item.canonicalUrls.join(', ') : '(no external URL)'
  const collision = item.classification.collision ? ' Name collision with an installed capability detected; nothing was installed or executed.' : ''
  const text = item.text.replace(/\s+/gu, ' ').trim().slice(0, 500)
  return `${noteMarker(item.id)} ${item.classification.kind} → REVIEW in #${item.classification.room}.${collision} `
    + `Source: @${item.author.username}: “${text}” URLs: ${urls}. `
    + `Reason: ${item.classification.rationale} Receipt: ${item.receiptPath}`
}

export function validDispatcherState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return false
  if (value.cursor !== null && (!value.cursor || typeof value.cursor.tweetId !== 'string' || typeof value.cursor.createdAt !== 'string')) return false
  return Number.isInteger(value.consecutiveFailures) && value.consecutiveFailures >= 0
}
