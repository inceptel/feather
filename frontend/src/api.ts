const BASE = location.pathname.replace(/\/+$/, '')

function bq(url: string, box?: string) {
  if (!box || box === 'local') return url
  return url + (url.includes('?') ? '&' : '?') + `box=${encodeURIComponent(box)}`
}

export interface SessionMeta {
  id: string
  title: string
  updatedAt: string
  isActive: boolean
  box?: string
  boxLabel?: string
}

export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  input?: any
  content?: any
  is_error?: boolean
}

export interface Message {
  uuid: string
  role: 'user' | 'assistant'
  timestamp: string
  content: ContentBlock[]
  delivery?: 'sent' | 'delivered'
}

export interface BoxInfo {
  boxes: Record<string, { url: string | null, label: string }>
  status: Record<string, string>
}

export async function fetchBoxes(): Promise<BoxInfo> {
  const r = await fetch(`${BASE}/api/boxes`)
  if (!r.ok) return { boxes: { local: { url: null, label: 'Local' } }, status: { local: 'ok' } }
  return await r.json()
}

export async function fetchSessions(box?: string): Promise<SessionMeta[]> {
  const url = box ? bq(`${BASE}/api/sessions`, box) : `${BASE}/api/sessions`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).sessions
}

export async function fetchMessages(id: string, before = 0, box?: string): Promise<{ messages: Message[], hasMore: boolean }> {
  const url = before > 0
    ? bq(`${BASE}/api/sessions/${id}/messages?before=${before}`, box)
    : bq(`${BASE}/api/sessions/${id}/messages`, box)
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return await r.json()
}

export const sendInput = (id: string, text: string, box?: string): Promise<{ ok: boolean, sentAt: string }> =>
  fetch(bq(`${BASE}/api/sessions/${id}/send`, box), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    .then(r => r.json())

export async function createSession(cwd?: string, box?: string): Promise<string> {
  const id = crypto.randomUUID()
  await fetch(bq(`${BASE}/api/sessions`, box), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, cwd }) })
  return id
}

export const resumeSession = (id: string, cwd?: string, box?: string) =>
  fetch(bq(`${BASE}/api/sessions/${id}/resume`, box), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })

export const interruptSession = (id: string, box?: string) =>
  fetch(bq(`${BASE}/api/sessions/${id}/interrupt`, box), { method: 'POST' })

export async function uploadFile(blob: Blob, name: string): Promise<string> {
  const r = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
    body: blob,
  })
  const { path } = await r.json()
  return path
}

export const deleteSession = (id: string, box?: string) =>
  fetch(bq(`${BASE}/api/sessions/${id}/delete`, box), { method: 'POST' }).then(r => r.json())

export const renameSession = (id: string, title: string, box?: string) =>
  fetch(bq(`${BASE}/api/sessions/${id}/rename`, box), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }).then(r => r.json())

export const forkSession = (id: string, cwd?: string, box?: string) =>
  fetch(bq(`${BASE}/api/sessions/${id}/fork`, box), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) }).then(r => r.json())

export const fetchStarred = (): Promise<Record<string, string[]>> =>
  fetch(`${BASE}/api/starred`).then(r => r.json())

export const saveStarred = (data: Record<string, string[]>) =>
  fetch(`${BASE}/api/starred`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json())

export const exportUrl = (id: string) => `${BASE}/api/sessions/${id}/export`

export const openInEditor = (path: string) =>
  fetch(`${BASE}/api/open-in-editor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).then(r => r.json())

export function subscribeMessages(
  id: string,
  onMessage: (msg: Message) => void,
  onStatus?: (status: 'connected' | 'reconnecting') => void,
  box?: string,
): () => void {
  let es: EventSource | null = null
  let closed = false
  let retries = 0
  let lastEventId = ''

  function connect() {
    if (closed) return
    const url = lastEventId
      ? bq(`${BASE}/api/sessions/${id}/stream?lastEventId=${lastEventId}`, box)
      : bq(`${BASE}/api/sessions/${id}/stream`, box)
    es = new EventSource(url)

    es.addEventListener('connected', () => { retries = 0; onStatus?.('connected') })
    es.addEventListener('message', (e) => {
      if (e.lastEventId) lastEventId = e.lastEventId
      try { onMessage(JSON.parse(e.data)) } catch {}
    })
    es.onerror = () => {
      es?.close(); es = null
      if (closed) return
      retries++
      onStatus?.('reconnecting')
      setTimeout(connect, Math.min(1000 * 2 ** Math.min(retries - 1, 5), 30000))
    }
  }

  connect()
  return () => { closed = true; es?.close(); es = null }
}
