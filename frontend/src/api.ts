export const BASE = location.pathname.replace(/\/+$/, '')

// Append ?box= so the server proxies the call to a remote/peer box
function bq(url: string, box?: string | null) {
  if (!box || box === 'local') return url
  return url + (url.includes('?') ? '&' : '?') + `box=${encodeURIComponent(box)}`
}

export interface SessionMeta {
  id: string
  title: string
  updatedAt: string
  isActive: boolean
  agent?: string
  isWorker?: boolean
  projectId?: string | null
  projectLabel?: string | null
  share?: string[]
}

export interface BoxInfo {
  id: string
  label: string
  available: boolean
  peer?: boolean
}

export interface PeerInfo {
  id: string
  policy: 'all' | 'selected'
  control: boolean
}

export interface Project {
  id: string
  label: string
}

export interface AgentInfo {
  id: string
  label: string
  available: boolean
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

export async function fetchAgents(): Promise<AgentInfo[]> {
  const r = await fetch(`${BASE}/api/agents`)
  if (!r.ok) return [{ id: 'claude', label: 'Claude Code', available: true }]
  return (await r.json()).agents
}

// Build version of the server that served this page. Used to auto-reload a
// stale client (e.g. a resident iOS PWA) when a newer build is deployed — see
// the version poll in App. cache:'no-store' so we don't read a stale copy.
export async function fetchBuildVersion(): Promise<string | null> {
  try {
    const r = await fetch(`${BASE}/api/health`, { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()).version ?? null
  } catch { return null }
}

export async function fetchBoxes(): Promise<BoxInfo[]> {
  const r = await fetch(`${BASE}/api/boxes`)
  if (!r.ok) return [{ id: 'local', label: 'Local', available: true }]
  return (await r.json()).boxes
}

export async function fetchSharingPeers(): Promise<{ owner: string | null, peers: PeerInfo[] }> {
  const r = await fetch(`${BASE}/api/sharing/peers`)
  if (!r.ok) return { owner: null, peers: [] }
  return await r.json()
}

export const setSessionShare = (id: string, peers: string[]) =>
  fetch(`${BASE}/api/sessions/${id}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ peers }) }).then(r => r.json())

// On a peer box the response also carries `control` (whether we may send)
export async function fetchSessions(box?: string | null): Promise<{ sessions: SessionMeta[], control?: boolean }> {
  const r = await fetch(bq(`${BASE}/api/sessions`, box))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return await r.json()
}

export async function fetchProjects(): Promise<Project[]> {
  const r = await fetch(`${BASE}/api/projects`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).projects
}

export async function fetchMessages(id: string, before = 0, box?: string | null): Promise<{ messages: Message[], hasMore: boolean }> {
  const url = before > 0
    ? `${BASE}/api/sessions/${id}/messages?before=${before}`
    : `${BASE}/api/sessions/${id}/messages`
  const r = await fetch(bq(url, box))
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return await r.json()
}

export const sendInput = (id: string, text: string, box?: string | null): Promise<{ ok: boolean, sentAt: string }> =>
  fetch(bq(`${BASE}/api/sessions/${id}/send`, box), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    .then(r => r.json())

export async function createSession(cwd?: string, agent?: string): Promise<string> {
  const id = crypto.randomUUID()
  await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, cwd, agent }) })
  return id
}

export const resumeSession = (id: string, cwd?: string) =>
  fetch(`${BASE}/api/sessions/${id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })

export const interruptSession = (id: string, box?: string | null) =>
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

export const deleteSession = (id: string) =>
  fetch(`${BASE}/api/sessions/${id}/delete`, { method: 'POST' }).then(r => r.json())

export const renameSession = (id: string, title: string) =>
  fetch(`${BASE}/api/sessions/${id}/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }).then(r => r.json())

export const forkSession = (id: string, cwd?: string) =>
  fetch(`${BASE}/api/sessions/${id}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) }).then(r => r.json())

export const fetchStarred = (): Promise<Record<string, string[]>> =>
  fetch(`${BASE}/api/starred`).then(r => r.json())

export const saveStarred = (data: Record<string, string[]>) =>
  fetch(`${BASE}/api/starred`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json())

export const exportUrl = (id: string, box?: string | null) => bq(`${BASE}/api/sessions/${id}/export`, box)

export const openInEditor = (path: string) =>
  fetch(`${BASE}/api/open-in-editor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }).then(r => r.json())

export interface FileEntry { name: string; type: 'dir' | 'file'; size: number; mtime: number }
export interface FileListing { path: string; parent: string | null; entries: FileEntry[] }

export async function fetchFiles(dir?: string, hidden = false): Promise<FileListing> {
  const params = new URLSearchParams()
  if (dir) params.set('path', dir)
  if (hidden) params.set('hidden', '1')
  const r = await fetch(`${BASE}/api/files${params.toString() ? `?${params}` : ''}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export async function deletePath(path: string): Promise<void> {
  const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try { msg = (await r.json()).error || msg } catch {}
    throw new Error(msg)
  }
}

export function subscribeMessages(
  id: string,
  onMessage: (msg: Message) => void,
  onStatus?: (status: 'connected' | 'reconnecting') => void,
  box?: string | null,
): () => void {
  let es: EventSource | null = null
  let closed = false
  let retries = 0
  let lastEventId = ''

  function connect() {
    if (closed) return
    const url = bq(lastEventId
      ? `${BASE}/api/sessions/${id}/stream?lastEventId=${lastEventId}`
      : `${BASE}/api/sessions/${id}/stream`, box)
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
