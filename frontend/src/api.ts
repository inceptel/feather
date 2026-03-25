const BASE = ''

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

async function ensureOk(response: Response): Promise<Response> {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response
}

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
  const data = await readJson<{ sessions: SessionMeta[] }>(await fetch(`${BASE}/api/sessions`))
  return data.sessions
}

export async function fetchMessages(id: string): Promise<Message[]> {
  const data = await readJson<{ messages: Message[] }>(await fetch(`${BASE}/api/sessions/${id}/messages`))
  return data.messages
}

export const sendInput = (id: string, text: string): Promise<{ ok: boolean, sentAt: string }> =>
  fetch(`${BASE}/api/sessions/${id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    .then(readJson<{ ok: boolean, sentAt: string }>)

export async function createSession(cwd?: string): Promise<string> {
  const id = crypto.randomUUID()
  await ensureOk(await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, cwd }) }))
  return id
}

export const resumeSession = (id: string, cwd?: string) =>
  fetch(`${BASE}/api/sessions/${id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })
    .then(ensureOk)

export const interruptSession = (id: string) =>
  fetch(`${BASE}/api/sessions/${id}/interrupt`, { method: 'POST' })
    .then(ensureOk)

export async function uploadFile(blob: Blob, name: string): Promise<string> {
  const data = await readJson<{ path: string }>(await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(name) },
    body: blob,
  }))
  return data.path
}

export function subscribeMessages(id: string, onMessage: (msg: Message) => void): () => void {
  const es = new EventSource(`${BASE}/api/sessions/${id}/stream`)
  es.addEventListener('message', (e) => { try { onMessage(JSON.parse(e.data)) } catch {} })
  return () => es.close()
}
