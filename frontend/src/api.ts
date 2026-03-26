const BASE = location.pathname.replace(/\/+$/, '')

export interface SessionMeta {
  id: string
  title: string
  updatedAt: string
  isActive: boolean
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

export async function fetchSessions(): Promise<SessionMeta[]> {
  const r = await fetch(`${BASE}/api/sessions`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).sessions
}

export async function fetchMessages(id: string): Promise<Message[]> {
  const r = await fetch(`${BASE}/api/sessions/${id}/messages`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).messages
}

export const sendInput = (id: string, text: string): Promise<{ ok: boolean, sentAt: string }> =>
  fetch(`${BASE}/api/sessions/${id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    .then(r => r.json())

export async function createSession(cwd?: string): Promise<string> {
  const id = crypto.randomUUID()
  await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, cwd }) })
  return id
}

export const resumeSession = (id: string, cwd?: string) =>
  fetch(`${BASE}/api/sessions/${id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })

export const interruptSession = (id: string) =>
  fetch(`${BASE}/api/sessions/${id}/interrupt`, { method: 'POST' })

export async function uploadFile(blob: Blob, name: string): Promise<string> {
  const r = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
    body: blob,
  })
  const { path } = await r.json()
  return path
}

export function subscribeMessages(id: string, onMessage: (msg: Message) => void): () => void {
  const es = new EventSource(`${BASE}/api/sessions/${id}/stream`)
  es.addEventListener('message', (e) => { try { onMessage(JSON.parse(e.data)) } catch {} })
  return () => es.close()
}
