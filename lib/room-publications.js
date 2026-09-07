import fs from 'fs'
import path from 'path'

export const ROOM_PUBLICATIONS_FILE = 'feed-publications.jsonl'
export const ROOM_PUBLICATION_MAX_VISUAL_BYTES = 5 * 1024 * 1024

const PUBLICATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/
const VISUAL_RE = /^artifacts\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp)$/i
const PUBLICATION_ATTENTION_LEVELS = new Set(['briefing', 'by-the-way'])
const PUBLICATION_FIELDS = ['id', 'sourceEvidenceId', 'attention', 'title', 'summary', 'detail', 'visual', 'visualAlt']

function publicationError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function text(value, maxCodePoints, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw publicationError(400, `${label} required`)
    return null
  }
  if (typeof value !== 'string') throw publicationError(400, `${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed && required) throw publicationError(400, `${label} required`)
  if ([...trimmed].length > maxCodePoints) throw publicationError(400, `${label} exceeds ${maxCodePoints} characters`)
  if (/\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    throw publicationError(400, `${label} contains control characters`)
  }
  return trimmed || null
}

function publicationAttention(value) {
  if (value === undefined || value === null) return 'briefing'
  if (!PUBLICATION_ATTENTION_LEVELS.has(value)) {
    throw publicationError(400, 'attention must be briefing or by-the-way')
  }
  return value
}

function normalizedInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw publicationError(400, 'publication must be an object')
  const id = text(input.id, 128, 'id', { required: true })
  if (!PUBLICATION_ID_RE.test(id)) throw publicationError(400, 'invalid publication id')
  const visual = text(input.visual, 160, 'visual')
  const visualAlt = text(input.visualAlt, 500, 'visualAlt')
  if (visual && !VISUAL_RE.test(visual)) throw publicationError(400, 'visual must be a Room-relative PNG, JPEG, or WebP under artifacts/')
  if (Boolean(visual) !== Boolean(visualAlt)) throw publicationError(400, 'visual and visualAlt must be supplied together')
  return {
    id,
    attention: publicationAttention(input.attention),
    sourceEvidenceId: text(input.sourceEvidenceId, 500, 'sourceEvidenceId', { required: true }),
    title: text(input.title, 160, 'title', { required: true }),
    summary: text(input.summary, 9_000, 'summary', { required: true }),
    detail: text(input.detail, 9_000, 'detail'),
    visual,
    visualAlt,
  }
}

function isPublicationRecord(record, roomName) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false
  let normalized
  try { normalized = normalizedInput(record) } catch { return false }
  return record.room === roomName
    && samePublication(record, normalized)
    && typeof record.occurredAt === 'string' && Number.isFinite(Date.parse(record.occurredAt))
    && typeof record.publisherSessionId === 'string' && record.publisherSessionId.length > 0
}


export function readRoomPublications(roomRoot, roomName) {
  const file = path.join(roomRoot, ROOM_PUBLICATIONS_FILE)
  let source
  try { source = fs.readFileSync(file, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return source.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const record = JSON.parse(line)
      return isPublicationRecord(record, roomName) ? [record] : []
    } catch { return [] }
  })
}

export function verifiedPublicationVisual(roomRoot, visual) {
  if (typeof visual !== 'string' || !VISUAL_RE.test(visual)) throw publicationError(404, 'visual not found')
  try {
    const artifacts = path.join(roomRoot, 'artifacts')
    const artifactsStat = fs.lstatSync(artifacts)
    if (artifactsStat.isSymbolicLink() || !artifactsStat.isDirectory()) throw publicationError(404, 'visual not found')
    const candidate = path.join(roomRoot, visual)
    const stat = fs.lstatSync(candidate)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 12 || stat.size > ROOM_PUBLICATION_MAX_VISUAL_BYTES) {
      throw publicationError(404, 'visual not found')
    }
    if (path.dirname(fs.realpathSync(candidate)) !== fs.realpathSync(artifacts)) throw publicationError(404, 'visual not found')
    const signature = Buffer.allocUnsafe(12)
    const fd = fs.openSync(candidate, 'r')
    try { fs.readSync(fd, signature, 0, signature.length, 0) }
    finally { fs.closeSync(fd) }
    const extension = path.extname(candidate).toLowerCase()
    const validSignature = extension === '.png'
      ? signature.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : extension === '.webp'
        ? signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP'
        : signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff
    if (!validSignature) throw publicationError(404, 'visual not found')
    return candidate
  } catch (error) {
    if (error.status === 404) throw error
    throw publicationError(404, 'visual not found')
  }
}

function samePublication(left, right) {
  return PUBLICATION_FIELDS.every((key) => {
    const leftValue = key === 'attention' && left[key] === undefined ? 'briefing' : left[key]
    return leftValue === right[key]
  })
}

export function appendRoomPublication({ roomRoot, roomName, publisherSessionId, input, now = new Date() }) {
  const normalized = normalizedInput(input)
  if (!Number.isFinite(now.getTime())) throw publicationError(500, 'invalid publication clock')
  if (normalized.visual) verifiedPublicationVisual(roomRoot, normalized.visual)
  const existing = readRoomPublications(roomRoot, roomName)
  const byId = existing.find(record => record.id === normalized.id)
  if (byId) {
    if (samePublication(byId, normalized)) return { record: byId, reused: true }
    // Same card, new content: the marketer attaches an image, or the copy is
    // edited for a reader. Update in place; the card keeps its place in time.
    const record = { ...byId, ...normalized, updatedAt: now.toISOString() }
    const file = path.join(roomRoot, ROOM_PUBLICATIONS_FILE)
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line).id === normalized.id ? JSON.stringify(record) : line } catch { return line }
    })
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
    return { record, reused: false, updated: true }
  }
  if (existing.some(record => record.sourceEvidenceId === normalized.sourceEvidenceId)) {
    throw publicationError(409, 'source evidence was already published')
  }
  const occurredAt = now.toISOString()
  const record = { room: roomName, ...normalized, occurredAt, publisherSessionId }
  fs.appendFileSync(path.join(roomRoot, ROOM_PUBLICATIONS_FILE), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
  return { record, reused: false }
}
