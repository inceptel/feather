import { appBasePath } from './lib/appPath.js'

export const BASE = appBasePath()

// Append ?box= so the server proxies the call to a remote/peer box
function bq(url: string, box?: string | null) {
  if (!box || box === 'local') return url
  return url + (url.includes('?') ? '&' : '?') + `box=${encodeURIComponent(box)}`
}

async function responseJson<T = any>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status })
  }
  return data as T
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
  roomAssigned?: boolean
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
  id?: string
  tool_use_id?: string
  text?: string
  thinking?: string
  name?: string
  intent?: string
  input?: any
  content?: any
  details?: unknown
  is_error?: boolean
  toolCallId?: string
  toolName?: string
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: boolean
  subagentId?: string
}

export interface Message {
  uuid: string
  role: 'user' | 'assistant'
  timestamp: string
  content: ContentBlock[]
  delivery?: 'sent' | 'delivered'
}

export type ProtocolRunStatus =
  | 'starting'
  | 'start_failed'
  | 'pending'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type ProtocolSeatStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled'
export type ProtocolStageStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

export interface ProtocolRanking {
  seatId: string
  rationale: string
}

export interface ProtocolDisagreement {
  summary: string
  evidenceIds: string[]
}

export interface ProtocolVerdict {
  ranking: ProtocolRanking[]
  recommendation: string
  disagreements: ProtocolDisagreement[]
  confidence: 'low' | 'medium' | 'high'
  citedEvidenceIds: string[]
}

export interface ProtocolSeatSnapshot {
  seatId: string
  stageId: 'candidates' | 'judge'
  attempt: number
  role: string
  status: ProtocolSeatStatus
  evidenceIds?: string[]
  ompChildId?: string
  reason?: string
  startedAt?: string
  finishedAt?: string
}

export interface ProtocolAttemptSnapshot {
  attempt: number
  status: ProtocolStageStatus
  seats: ProtocolSeatSnapshot[]
  reason?: string
}

export interface ProtocolStageSnapshot {
  stageId: 'candidates' | 'judge'
  status: ProtocolStageStatus
  attempts: ProtocolAttemptSnapshot[]
  reason?: string
}

export interface ProtocolEvidenceSnapshot {
  evidenceId: string
  kind: 'candidate_answer' | 'judge_verdict'
  stageId: 'candidates' | 'judge'
  seatId: string
  attempt: number
  content: string | ProtocolVerdict
  artifactReferences?: string[]
}

export interface ProtocolRunSnapshot {
  schemaVersion: 1
  sessionId: string
  runId: string
  protocol: 'advisory'
  status: ProtocolRunStatus
  lastSeq: number
  invocationMessageId: string
  actionId: string
  question: string
  candidateCount: number
  roles: Array<{ seatId: string; role: string }>
  roleMode: 'diverse' | 'neutral'
  timeoutMs: number
  rubric?: string
  sourceRunId?: string
  ownerExecutionId?: string
  createdAt: string
  updatedAt?: string
  startedAt?: string
  finishedAt?: string
  stages: ProtocolStageSnapshot[]
  seats: ProtocolSeatSnapshot[]
  evidence: ProtocolEvidenceSnapshot[]
  verdict: ProtocolVerdict | null
  verdictEvidenceId?: string | null
  verdictRecordedAt?: string
  cancelActionId?: string
  reason?: string
  error?: string
}


export interface RoomInfo {
  name: string
  cwd: string
  sessions: SessionMeta[]
  mainSessionId: string | null
  active: boolean
  latest: { role: string, text: string } | null
  updatedAt: string | null
  updates: { count: number, latestAt: string | null, latest: string | null }
  friction: { count: number, latestAt: string | null, latest: string | null }
  pulse: {
    enabled: boolean
    status: 'waiting' | 'working' | 'paused' | 'error'
    lastRunAt: string | null
    nextRunAt: string | null
    sessionId: string | null
    error?: string | null
  }
}

export async function fetchRooms(): Promise<RoomInfo[]> {
  const r = await fetch(`${BASE}/api/rooms`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).rooms
}

export interface RoomUpdate { id: string | null, ts: string | null, text: string }

export async function fetchRoomUpdates(room: string): Promise<RoomUpdate[]> {
  const r = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/updates`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).updates
}

export interface FrictionComplaint {
  id: string
  timestamp: string
  source: string
  summary: string
  evidence: string | null
}

export async function fetchRoomFriction(room: string): Promise<FrictionComplaint[]> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/friction`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()).complaints
}

export async function createRoom(name: string): Promise<{ name: string, cwd: string }> {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
  return responseJson(r)
}

export const assignSessionToRoom = async (room: string, sessionId: string, remove = false) => {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, remove }),
  })
  return responseJson<{ ok: true, assignments: Record<string, string> }>(response)
}

export async function setRoomMain(room: string, sessionId: string): Promise<{ mainSessionId: string, pulse: RoomInfo['pulse'] }> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/main`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  })
  return responseJson<{ ok: true, mainSessionId: string, pulse: RoomInfo['pulse'] }>(response)
}

export async function setRoomPulse(room: string, enabled: boolean): Promise<RoomInfo['pulse']> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/pulse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  return (await responseJson<{ ok: true, pulse: RoomInfo['pulse'] }>(response)).pulse
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

// On a peer box the response also carries `control` (whether we may send).
// `q` searches ALL sessions (titles + full content, server-side) instead of
// just the most-recent-50 the plain listing returns.
export async function fetchSessions(box?: string | null, q?: string, limit?: number): Promise<{ sessions: SessionMeta[], control?: boolean }> {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (limit) params.set('limit', String(limit))
  const queryString = params.toString()
  const url = `${BASE}/api/sessions${queryString ? `?${queryString}` : ''}`
  const r = await fetch(bq(url, box))
  return responseJson<{ sessions: SessionMeta[], control?: boolean }>(r)
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

export async function fetchProtocolRuns(id: string, box?: string | null): Promise<{ runs: ProtocolRunSnapshot[] }> {
  const response = await fetch(bq(`${BASE}/api/sessions/${id}/protocol-runs`, box))
  return responseJson<{ runs: ProtocolRunSnapshot[] }>(response)
}


export async function sendInput(id: string, text: string, box?: string | null, messageId?: string): Promise<{ ok: boolean, sentAt: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (messageId) headers['X-Feather-Message-ID'] = messageId
  const r = await fetch(bq(`${BASE}/api/sessions/${id}/send`, box), { method: 'POST', headers, body: JSON.stringify({ text }) })
  const data = await responseJson<{ ok?: boolean, sentAt: string, error?: string }>(r)
  if (data.ok !== true) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status })
  return data
}
export async function sendSessionKeys(id: string, keys: string[], box?: string | null): Promise<void> {
  const r = await fetch(bq(`${BASE}/api/sessions/${id}/keys`, box), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  })
  const data = await responseJson<{ ok?: boolean; error?: string }>(r)
  if (data.ok !== true) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status })
}


export async function createSession(cwd?: string, agent?: string): Promise<string> {
  const id = crypto.randomUUID()
  const r = await fetch(`${BASE}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, cwd, agent }) })
  await responseJson(r)
  return id
}

export const resumeSession = (id: string, cwd?: string) =>
  fetch(`${BASE}/api/sessions/${id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) })

export const interruptSession = (id: string, box?: string | null) =>
  fetch(bq(`${BASE}/api/sessions/${id}/interrupt`, box), { method: 'POST' })

export async function uploadFileWithId(blob: Blob, name: string, uploadId: string, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${BASE}/api/upload`, {
    method: 'POST', signal,
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
      'X-Filename': encodeURIComponent(name),
      'X-Upload-ID': uploadId,
    },
    body: blob,
  })
  const data = await responseJson<{ path?: string }>(r)
  if (typeof data.path !== 'string' || !data.path.startsWith('/')) throw new Error('Upload response did not include a valid path')
  return data.path
}

export async function transcribeAudio(blob: Blob, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${BASE}/api/transcribe`, {
    method: 'POST', signal,
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  })
  const data = await responseJson<{ transcript?: string }>(r)
  if (typeof data.transcript !== 'string') throw new Error('Transcription response did not include text')
  if (!data.transcript.trim()) throw new Error('No speech was detected')
  return data.transcript.trim()
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

// ── Sidecar: paired agent threads ───────────────────────────────────────────

export interface SidecarMessage { ts: number; from: string; to: string; text: string }
export interface SidecarMember { sessionId: string; role: string; spawned?: boolean }
export interface SidecarGroup {
  id: string
  members: SidecarMember[]
  agent: string
  task: string
  status: string
  createdAt: number
}

export const fetchSidecars = (): Promise<{ groups: SidecarGroup[] }> =>
  fetch(`${BASE}/api/sidecar`).then(r => r.json())

export const fetchSidecar = (id: string): Promise<{ group: SidecarGroup; thread: SidecarMessage[] }> =>
  fetch(`${BASE}/api/sidecar/${id}`).then(r => r.json())

export const createSidecar = (
  driverSessionId: string,
  opts: { agent?: string; task?: string; cwd?: string; driverRole?: string; peerRole?: string } = {},
): Promise<{ group: SidecarGroup; peerSessionId: string }> =>
  fetch(`${BASE}/api/sidecar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driverSessionId, ...opts }) }).then(r => r.json())

export const postSidecar = (id: string, to: string, text: string, from = 'driver') =>
  fetch(`${BASE}/api/sidecar/${id}/post`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, text }) }).then(r => r.json())

export const deleteSidecar = (id: string) =>
  fetch(`${BASE}/api/sidecar/${id}/delete`, { method: 'POST' }).then(r => r.json())

export const addSidecarPeer = (id: string, role: string, opts: { agent?: string; task?: string } = {}) =>
  fetch(`${BASE}/api/sidecar/${id}/peers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, ...opts }) }).then(r => r.json())

export const removeSidecarPeer = (id: string, role: string) =>
  fetch(`${BASE}/api/sidecar/${id}/peers/${encodeURIComponent(role)}/delete`, { method: 'POST' }).then(r => r.json())

export function subscribeSidecar(id: string, onMessage: (m: SidecarMessage) => void): () => void {
  let es: EventSource | null = new EventSource(`${BASE}/api/sidecar/${id}/stream`)
  es.addEventListener('message', (e) => { try { onMessage(JSON.parse(e.data)) } catch {} })
  return () => { es?.close(); es = null }
}

export interface OmpTodoPhase {
  name: string
  tasks: Array<{ content: string; status: string; blocker?: string }>
}

export interface OmpAsyncJob {
  id: string
  type: string
  status: string
  startTime: number
  label?: string
}
export interface OmpTodoSnapshot {
  phases: OmpTodoPhase[]
  completed: number
  total: number
  active: string | null
}

export type OmpExecutionStatus = 'running' | 'success' | 'error' | 'cancelled'

export type OmpTimelineItem =
  | { key: string; kind: 'thinking'; text: string; status: OmpExecutionStatus }
  | {
      key: string
      kind: 'tool'
      toolCallId: string
      toolName: string
      status: OmpExecutionStatus
      args?: unknown
      intent?: string
      partialResult?: unknown
      result?: unknown
      isError?: boolean
    }

export interface OmpWorkScope {
  timeline: OmpTimelineItem[]
  todo: OmpTodoSnapshot | null
  activeMessageId: string | null
  runStatus: 'idle' | OmpExecutionStatus
  assistantText: string
  assistantEnded: boolean
  continuationPending: boolean
  segment: number
}

export interface OmpSubagentState extends OmpWorkScope {
  id: string
  agent: string
  status: string
  index: number
  detached: boolean
  description?: string
  intent?: string
  resolvedModel?: string
  agentSource?: string
  task?: string
  assignment?: string
  sessionFile?: string
  parentToolCallId?: string
  toolCount?: number
  requests?: number
  tokens?: number
  durationMs?: number
}

export interface OmpMirrorState {
  parent: OmpWorkScope
  children: Record<string, OmpSubagentState>
  childOrder: string[]
}


export interface OmpBridgeEvent {
  type: string
  messageId?: string
  text?: string
  reason?: string
  blocks?: ContentBlock[]
  attempt?: number
  provider?: string
  maxAttempts?: number
  delayMs?: number
  success?: boolean
  finalError?: string
  aborted?: boolean
  errorMessage?: string
  willContinue?: boolean
  toolCallId?: string
  toolName?: string
  approvalMode?: string
  approved?: boolean
  phases?: OmpTodoPhase[]
  isError?: boolean
  args?: unknown
  partialResult?: unknown
  result?: unknown
  subagentId?: string
  id?: string
  agent?: string
  status?: string
  index?: number
  detached?: boolean
  description?: string
  intent?: string
  resolvedModel?: string
  toolCount?: number
  requests?: number
  tokens?: number
  durationMs?: number
  agentSource?: string
  task?: string
  assignment?: string
  sessionFile?: string
  parentToolCallId?: string
  running?: OmpAsyncJob[]
  recent?: OmpAsyncJob[]
  delivery?: { queued: number; delivering: boolean }
  modelProvider?: string
  modelId?: string
  modelApi?: string
  thinkingLevel?: string
  serviceTiers?: Record<string, string | null>
  contextTokens?: number
  contextWindow?: number
  contextPercent?: number
}

export interface SubscribeMessagesOptions {
  onMessage: (message: Message) => void
  onStatus?: (status: 'connected' | 'reconnecting') => void
  box?: string | null
  onOmpEvent?: (event: OmpBridgeEvent) => void
  onProtocolRun?: (run: ProtocolRunSnapshot) => void
}

export function subscribeMessages(id: string, options: SubscribeMessagesOptions): () => void {
  const { onMessage, onStatus, box, onOmpEvent, onProtocolRun } = options
  let es: EventSource | null = null
  let closed = false
  let retries = 0
  let lastEventId = ''
  let gen = 0
  let watchdog: ReturnType<typeof setTimeout> | null = null
  // The server heartbeats every 15s. If even those stop arriving the stream is a
  // zombie — common on mobile, where a network change kills the TCP socket but
  // EventSource never fires onerror, so messages silently stop until a full page
  // refresh. Any event (connected/heartbeat/message) rearms this; if it lapses,
  // we tear the socket down and reconnect, resuming from the last byte offset.
  const IDLE_TIMEOUT = 40000
  function armWatchdog() {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      if (closed) return
      onStatus?.('reconnecting')
      try { es?.close() } catch {}
      connect() // bumps gen, so the dead source's late handlers become no-ops
    }, IDLE_TIMEOUT)
  }

  function connect() {
    if (closed) return
    const myGen = ++gen
    const url = bq(lastEventId
      ? `${BASE}/api/sessions/${id}/stream?lastEventId=${lastEventId}`
      : `${BASE}/api/sessions/${id}/stream`, box)
    const source = new EventSource(url)
    es = source
    armWatchdog()

    source.addEventListener('connected', () => { if (myGen !== gen) return; retries = 0; armWatchdog(); onStatus?.('connected') })
    source.addEventListener('heartbeat', () => { if (myGen === gen) armWatchdog() })
    source.addEventListener('message', (e) => {
      if (myGen !== gen) return
      armWatchdog()
      if (e.lastEventId) lastEventId = e.lastEventId
      try { onMessage(JSON.parse(e.data)) } catch {}
    })
    source.addEventListener('omp_event', (e) => {
      if (myGen !== gen) return
      armWatchdog()
      try { onOmpEvent?.(JSON.parse(e.data)) } catch {}
    })
    source.addEventListener('protocol_run', (e) => {
      if (myGen !== gen) return
      armWatchdog()
      try { onProtocolRun?.(JSON.parse(e.data)) } catch {}
    })
    source.onerror = () => {
      if (closed || myGen !== gen) return
      if (watchdog) { clearTimeout(watchdog); watchdog = null }
      try { source.close() } catch {}
      retries++
      onStatus?.('reconnecting')
      setTimeout(connect, Math.min(1000 * 2 ** Math.min(retries - 1, 5), 30000))
    }
  }

  connect()
  return () => { closed = true; if (watchdog) clearTimeout(watchdog); es?.close(); es = null }
}
