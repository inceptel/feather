import fs from 'fs'
import path from 'path'

const VERSION = 1
const WRITE_DELAY_MS = 250

function validFact(value) {
  return value && typeof value === 'object'
    && Number.isFinite(value.mtimeMs)
    && Number.isFinite(value.size)
    && typeof value.agent === 'string'
    && Number.isFinite(value.activityMs)
    && (value.projectId === null || typeof value.projectId === 'string')
    && (value.title === null || value.title === undefined || typeof value.title === 'string')
    && typeof value.worker === 'boolean'
}

function load(file) {
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (document?.version !== VERSION || !Array.isArray(document.entries)) return new Map()
    return new Map(document.entries.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && validFact(entry[1])))
  } catch {
    return new Map()
  }
}

// Disposable, durable cache for transcript-derived session facts. Writes are
// coalesced and asynchronous so session listing never pays for persistence.
export function createSessionFactsCache({ file, writeDelayMs = WRITE_DELAY_MS, onError = () => {} }) {
  const entries = load(file)
  let revision = 0
  let flushedRevision = 0
  let timer = null
  let inFlight = null

  function schedule() {
    if (timer || inFlight || revision === flushedRevision) return
    timer = setTimeout(() => {
      timer = null
      void flush().catch(onError)
    }, writeDelayMs)
    timer.unref?.()
  }

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null }
    if (inFlight) {
      await inFlight
      if (revision !== flushedRevision) return flush()
      return
    }
    if (revision === flushedRevision) return
    const targetRevision = revision
    const bytes = `${JSON.stringify({ version: VERSION, entries: [...entries] })}\n`
    const temporary = `${file}.${process.pid}.${targetRevision}.tmp`
    inFlight = (async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.writeFile(temporary, bytes, { mode: 0o600 })
      await fs.promises.rename(temporary, file)
      flushedRevision = targetRevision
    })()
    try {
      await inFlight
    } catch (error) {
      // This cache is disposable. Avoid a retry loop on a read-only or full
      // filesystem; a later mutation will make one new persistence attempt.
      flushedRevision = targetRevision
      throw error
    } finally {
      inFlight = null
      try { await fs.promises.unlink(temporary) } catch {}
      schedule()
    }
  }

  function set(fpath, facts) {
    const current = entries.get(fpath)
    if (current && JSON.stringify(current) === JSON.stringify(facts)) return facts
    entries.set(fpath, facts)
    revision++
    schedule()
    return facts
  }

  function retain(fpaths) {
    const keep = fpaths instanceof Set ? fpaths : new Set(fpaths)
    let changed = false
    for (const fpath of entries.keys()) {
      if (keep.has(fpath)) continue
      entries.delete(fpath)
      changed = true
    }
    if (changed) { revision++; schedule() }
  }

  return Object.freeze({
    get: fpath => entries.get(fpath),
    set,
    retain,
    flush,
    get size() { return entries.size },
  })
}
