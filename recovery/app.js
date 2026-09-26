const byId = id => document.getElementById(id)
const status = byId('status')
const errorBox = byId('error')
const prompt = byId('prompt')
const send = byId('send')
const stop = byId('stop')
const older = byId('older')
const messages = byId('messages')
const pendingKey = 'feather-recovery-pending-v1'
const nodes = new Map()
let pending = null
let activeId = null
let connected = false
let sending = false
let more = null
let storageBlocked = false
let polling = false
let unavailable = false

function error(message) {
  errorBox.textContent = message
  errorBox.hidden = !message
}

try {
  const saved = localStorage.getItem(pendingKey)
  if (saved) {
    pending = JSON.parse(saved)
    if (!pending || typeof pending.id !== 'string' || typeof pending.text !== 'string') throw new Error('Invalid pending request')
    prompt.value = pending.text
  }
} catch {
  storageBlocked = true
  error('Browser storage is unavailable or contains an unreadable pending request. Sending is disabled to avoid losing or duplicating it. Restore browser storage before sending.')
}

async function api(route, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(`/recovery/api/${route}`, { cache: 'no-store', credentials: 'same-origin', ...options, signal: controller.signal })
    const type = response.headers.get('content-type') || ''
    if (!type.includes('application/json')) throw new Error('Recovery authentication or gateway unavailable. Sign in again, then reload this page.')
    const value = await response.json()
    if (!response.ok) throw Object.assign(new Error(value.error || `Request failed (${response.status})`), { status: response.status })
    return value
  } finally { clearTimeout(timer) }
}

function controls() {
  send.disabled = !connected || sending || storageBlocked || unavailable || !!activeId
  send.textContent = pending ? 'Retry same request' : 'Send'
  prompt.readOnly = !!pending
  stop.disabled = !connected || !activeId || sending
}

function render(turn, prepend = false) {
  let item = nodes.get(turn.id)
  if (!item) {
    const article = document.createElement('article')
    const heading = document.createElement('h2')
    heading.textContent = 'You'
    const user = document.createElement('pre')
    const meta = document.createElement('p')
    meta.className = 'meta'
    const assistant = document.createElement('pre')
    assistant.className = 'reply'
    const issue = document.createElement('p')
    issue.className = 'issue'
    const expand = document.createElement('button')
    expand.type = 'button'
    expand.textContent = 'Show more reply'
    article.append(heading, user, meta, assistant, issue, expand)
    if (prepend) messages.prepend(article)
    else messages.append(article)
    item = { article, user, meta, assistant, issue, expand, shown: '', next: null }
    nodes.set(turn.id, item)
    expand.addEventListener('click', async () => {
      expand.disabled = true
      try {
        const page = await api(`turn/${turn.id}?offset=${item.next}`)
        item.shown += page.assistant
        item.next = page.next
        assistant.textContent = item.shown
        expand.hidden = item.next === null
      } catch (failure) { error(failure.message) }
      finally { expand.disabled = false }
    })
  }
  item.user.textContent = turn.user
  item.meta.textContent = `${new Date(turn.created).toLocaleString()} · ${turn.status}`
  // Responses append across complete OMP messages. Preserve manually expanded
  // pages while polling refreshes the first page.
  if (!item.shown.startsWith(turn.assistant) || item.shown.length <= turn.assistant.length) {
    item.shown = turn.assistant
  }
  if (!item.expand.disabled) {
    item.next = item.shown.length < turn.length ? item.shown.length : null
  }
  item.assistant.textContent = item.shown || (['working', 'stopping'].includes(turn.status) ? 'Working…' : '(No assistant text returned.)')
  item.expand.hidden = item.next === null
  item.issue.textContent = [turn.error, turn.truncated ? 'Display archive reached its 1 MiB text limit. The native recovery session retains the complete conversation on the host.' : ''].filter(Boolean).join('\n')
  item.issue.hidden = !item.issue.textContent
}

function acknowledge(turn) {
  if (pending?.id !== turn.id) return
  try {
    localStorage.removeItem(pendingKey)
    pending = null
    prompt.value = ''
    error('')
  } catch {
    storageBlocked = true
    error('Request was accepted, but browser storage could not be updated. Reload to reconcile the same saved request; do not create a duplicate.')
  }
}

async function poll() {
  if (polling) return
  polling = true
  try {
    const state = await api('state')
    connected = true
    activeId = state.activeId
    unavailable = state.storageError
    for (const turn of state.turns) { render(turn); acknowledge(turn) }
    if (pending) {
      try { const turn = await api(`turn/${pending.id}`); render(turn); acknowledge(turn) }
      catch (failure) {
        if (failure.status === 404) error('This saved request has not been confirmed. Use “Retry same request” to submit its original id safely.')
        else throw failure
      }
    }
    // Keep the oldest loaded page cursor after "Show older" was used.
    if (!older.dataset.paged) more = state.more
    older.hidden = !more
    status.textContent = unavailable ? 'Recovery storage needs attention. Sending is disabled.' : activeId ? 'Agent working. You can leave and return without losing the saved reply.' : 'Connected · recovery agent ready on demand'
  } catch (failure) {
    connected = false
    status.textContent = 'Disconnected · reconnecting. No requests are being resent.'
    error(failure.message)
  } finally {
    polling = false
    controls()
  }
}

byId('composer').addEventListener('submit', async event => {
  event.preventDefault()
  if (send.disabled) return
  if (!pending) {
    const text = prompt.value
    if (!text.trim()) return
    if (new TextEncoder().encode(text).length > 32768) { error('Message exceeds 32768 UTF-8 bytes. Shorten it before sending.'); return }
    const candidate = { id: crypto.randomUUID(), text }
    try { localStorage.setItem(pendingKey, JSON.stringify(candidate)); pending = candidate }
    catch { storageBlocked = true; error('Browser storage failed. Nothing was sent.'); controls(); return }
  }
  sending = true
  controls()
  error('')
  try {
    const turn = await api('send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending) })
    render(turn)
    acknowledge(turn)
  } catch (failure) {
    error(`${failure.message}. Your original request remains saved; reconnect and use “Retry same request”, never a fresh duplicate.`)
  } finally { sending = false; await poll(); controls() }
})

stop.addEventListener('click', async () => {
  if (!activeId || stop.disabled) return
  sending = true
  controls()
  try { await api('stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: activeId }) }) }
  catch (failure) { error(`Stop was not confirmed: ${failure.message}. Reconnect and try Stop again.`) }
  finally { sending = false; await poll(); controls() }
})

older.addEventListener('click', async () => {
  if (!more) return
  older.disabled = true
  try {
    const state = await api(`state?before=${encodeURIComponent(more)}`)
    for (const turn of [...state.turns].reverse()) render(turn, true)
    more = state.more
    older.dataset.paged = 'true'
    older.hidden = !more
  } catch (failure) { error(failure.message) }
  finally { older.disabled = false }
})

controls()
void poll()
setInterval(() => { void poll() }, 2000)
window.addEventListener('online', () => { void poll() })
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll() })
