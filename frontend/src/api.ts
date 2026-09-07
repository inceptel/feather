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


export interface RalphState {
  enabled: boolean
  status: 'waiting' | 'working' | 'scheduled' | 'blocked' | 'complete' | 'stopped' | 'error'
  iteration: number
  lastCallbackAt: string | null
  blockedReason: string | null
  completionReason: string | null
  error: string | null
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
  mode?: 'ralph'
  ralph?: RalphState
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
  passive?: boolean
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


export interface RoomResident {
  role: string
  sessionId: string
  agent: string
  title: string
  status: 'working' | 'waiting' | 'offline' | 'starting'
  model?: string
  contextPercent?: number
  wakeIntervalMs?: number | null
  nextWakeAtMs?: number | null
  lastWakeAt?: string | null
  paused?: boolean
}

export interface RoomInfo {
  name: string
  cwd: string
  mission?: string | null
  sessions: SessionMeta[]
  leaderSessionId: string | null
  residents: RoomResident[]
  residentsPaused?: boolean
  sidecarGroupId: string | null
  active: boolean
  latest: { role: string, text: string, id?: string | null, timestamp?: string | null } | null
  updatedAt: string | null
  updates: { count: number, latestAt: string | null, latest: string | null }
  friction: { count: number, resolvedCount?: number, latestAt: string | null, latest: string | null }
  pulse: {
    enabled: boolean
    status: 'waiting' | 'working' | 'paused' | 'error'
    lastRunAt: string | null
    nextRunAt: string | null
    sessionId: string | null
    error?: string | null
  }
  leaderWake?: RoomLeaderWake
}

// The Leader's autonomy: a wake schedule for working FRONTIER.md, the judge
// that grades each wake, and the usage-limit fallback the Leader may be on.
export interface RoomLeaderWake {
  enabled: boolean
  wakeIntervalMs: number | null
  nextWakeAtMs: number | null
  lastWakeAt: string | null
  paused: boolean
  judgeDue: boolean
  lastJudgeAt: string | null
  fallback: { model: string, primaryModel: string, since: string, reason: string, retryAt: string } | null
}

export interface RoomSessionContext {
  room: string | null
  kind: 'main' | 'resident' | 'status' | 'chat' | null
  role: string | null
  label: string | null
  forkOf: string | null
  forkSourceTitle: string | null
  workspaceMode: 'isolated' | 'shared' | null
  forkBranch: string | null
}

export async function fetchRooms(): Promise<RoomInfo[]> {
  const r = await fetch(`${BASE}/api/rooms`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).rooms
}

export async function fetchSessionRoomContext(sessionId: string): Promise<RoomSessionContext> {
  const response = await fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}/room`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

export async function fetchSessionRoom(sessionId: string): Promise<string | null> {
  return (await fetchSessionRoomContext(sessionId)).room
}



export interface RoomWikiPageMeta { name: string, size: number, updatedAt: string }
export interface RoomWikiPage { name: string, content: string, updatedAt: string }

export async function fetchRoomWiki(room: string): Promise<RoomWikiPageMeta[]> {
  const r = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/wiki`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()).pages
}

export async function fetchRoomWikiPage(room: string, page: string): Promise<RoomWikiPage> {
  const r = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/wiki/page?name=${encodeURIComponent(page)}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export interface FrictionComplaint {
  id: string
  timestamp: string
  source: string
  summary: string
  evidence: string | null
  resolvedAt?: string | null
  resolution?: string | null
}

export type SuperFeedView = 'latest' | 'review' | 'following' | 'friction'

export interface SuperFeedItem {
  evidenceId: string
  kind: 'update' | 'alert' | 'friction'
  room: string
  title: string
  summary: string
  detail: string | null
  occurredAt: string | null
  sourceHref: string
  sourceState: 'available' | 'stale'
  status: string | null
  needsReview: boolean
  sessionId: string | null
  complaintId?: string
  resolvedAt?: string | null
  resolution?: string | null
  publicationId?: string
  wikiPage?: string | null
  attention?: 'briefing' | 'by-the-way'
  visualHref?: string
  visualAlt?: string
  comments?: FeedComment[]
}

export interface FeedComment {
  id: string
  evidenceId: string
  room: string
  text: string
  createdAt: string
  reply: { text: string, timestamp: string } | null
}

export interface SuperFeedSnapshot {
  items: SuperFeedItem[]
  following: string[]
  cursor: string
  generatedAt: string
}

export interface SuperFeedFetchResult {
  snapshot: SuperFeedSnapshot | null
  etag: string | null
}

export async function fetchSuperFeed(etag?: string | null, signal?: AbortSignal): Promise<SuperFeedFetchResult> {
  const headers: Record<string, string> = {}
  if (etag) headers['If-None-Match'] = etag
  const response = await fetch(`${BASE}/api/feed`, { headers, signal })
  if (response.status === 304) return { snapshot: null, etag: etag || null }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return { snapshot: await response.json(), etag: response.headers.get('ETag') }
}

export async function setFeedFollowing(room: string, following: boolean): Promise<string[]> {
  const response = await fetch(`${BASE}/api/feed/following`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ room, following }),
  })
  return (await responseJson<{ ok: true, following: string[] }>(response)).following
}

export async function postFeedComment(evidenceId: string, text: string): Promise<FeedComment> {
  const response = await fetch(`${BASE}/api/feed/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ evidenceId, text }),
  })
  return (await responseJson<{ ok: true, comment: FeedComment }>(response)).comment
}

// Steer a Room from a card: the text lands under Steering in its FRONTIER.md
// and the Leader is woken at once.
export async function postRoomSteer(room: string, text: string): Promise<{ ok: true, room: string, at: string, leaderSessionId: string | null, woke: boolean }> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/steer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  return responseJson(response)
}

export async function fetchRoomFriction(room: string): Promise<FrictionComplaint[]> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/friction`)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()).complaints
}

export async function createRoom(name: string, mission?: string): Promise<{ name: string, cwd: string, leaderSessionId?: string }> {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mission: mission || undefined }) })
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


export async function setRoomPulse(room: string, enabled: boolean): Promise<RoomInfo['pulse']> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/pulse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  return (await responseJson<{ ok: true, pulse: RoomInfo['pulse'] }>(response)).pulse
}

export async function setRoomLeaderWake(room: string, body: { wakeIntervalMs?: number | null, paused?: boolean, now?: boolean, judge?: boolean }): Promise<RoomLeaderWake | null> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/leader/wake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await responseJson<{ ok: true, leaderWake: RoomLeaderWake | null }>(response)).leaderWake
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

const MESSAGE_PAGE_SIZE = 200
const INITIAL_MESSAGE_LIMIT = 1000

export interface MessagePage {
  messages: Message[]
  hasMore: boolean
  cursor: number
  nextBefore: number
}

async function fetchMessagePage(id: string, before: number, box?: string | null, limit = MESSAGE_PAGE_SIZE): Promise<MessagePage> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (before > 0) params.set('before', String(before))
  const response = await fetch(bq(`${BASE}/api/sessions/${id}/messages?${params}`, box))
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const page = await response.json()
  return {
    messages: Array.isArray(page.messages) ? page.messages : [],
    hasMore: !!page.hasMore,
    cursor: Number.isSafeInteger(page.cursor) && page.cursor >= 0 ? page.cursor : 0,
    nextBefore: Number.isSafeInteger(page.nextBefore) && page.nextBefore >= 0
      ? page.nextBefore
      : before + (Array.isArray(page.messages) ? page.messages.length : 0),
  }
}

export async function fetchMessages(id: string, before = 0, box?: string | null): Promise<MessagePage> {
  return fetchMessagePage(id, before, box, before > 0 ? MESSAGE_PAGE_SIZE : INITIAL_MESSAGE_LIMIT)
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


export async function createSession(cwd?: string, agent?: string, room?: { name: string, role: 'leader' }, mode?: 'ralph'): Promise<string> {
  const id = crypto.randomUUID()
  const r = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, cwd, agent, roomName: room?.name, roomRole: room?.role, mode }),
  })
  const created = await responseJson<{ id: string }>(r)
  return created.id
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

export async function renameSession(id: string, title: string): Promise<void> {
  const response = await fetch(`${BASE}/api/sessions/${id}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  await responseJson(response)
}

export async function forkSession(id: string, options: { title: string, workspaceMode: 'isolated' | 'shared' }): Promise<{
  id: string
  status: 'starting'
  room: string | null
  workspaceMode: 'isolated' | 'shared'
  workspacePath: string | null
  notice: string | null
}> {
  const response = await fetch(`${BASE}/api/sessions/${id}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  })
  return responseJson(response)
}

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

export interface SidecarMessage { ts: number; seq: number; from: string; to: string; text: string }
export interface SidecarMember { sessionId: string; role: string; spawned?: boolean }
export interface SidecarGroup {
  id: string
  kind?: 'sidecar' | 'room'
  roomName?: string
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

export async function postSidecar(id: string, to: string, text: string, from = 'driver') {
  const response = await fetch(`${BASE}/api/sidecar/${id}/post`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, text }) })
  return responseJson<{ ok: true, group: string, seq: number }>(response)
}

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
  invocationId: string
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
  invocationId?: string
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
  onMessage: (message: Message, offset: number) => void
  onStatus?: (status: 'connected' | 'reconnecting') => void
  box?: string | null
  onOmpEvent?: (event: OmpBridgeEvent) => void
  onProtocolRun?: (run: ProtocolRunSnapshot) => void
}

export interface MessageSubscription {
  connected: Promise<void>
  close: () => void
  setCursor: (cursor: number) => void
}

export function subscribeMessages(id: string, options: SubscribeMessagesOptions): MessageSubscription {
  const { onMessage, onStatus, box, onOmpEvent, onProtocolRun } = options
  let es: EventSource | null = null
  let closed = false
  let hasConnected = false
  let retries = 0
  let lastEventId = ''
  let gen = 0
  let watchdog: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const connectedGate = Promise.withResolvers<void>()
  const connected = connectedGate.promise
  const resolveConnected = connectedGate.resolve
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
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    try { es?.close() } catch {}
    const myGen = ++gen
    const url = bq(lastEventId
      ? `${BASE}/api/sessions/${id}/stream?lastEventId=${lastEventId}`
      : `${BASE}/api/sessions/${id}/stream`, box)
    const source = new EventSource(url)
    es = source
    armWatchdog()

    source.addEventListener('connected', () => {
      if (myGen !== gen) return
      retries = 0
      hasConnected = true
      armWatchdog()
      resolveConnected()
      onStatus?.('connected')
    })
    source.addEventListener('heartbeat', () => { if (myGen === gen) armWatchdog() })
    source.addEventListener('message', (e) => {
      if (myGen !== gen) return
      armWatchdog()
      const offset = Number.parseInt(e.lastEventId || '0', 10) || 0
      if (offset > (Number.parseInt(lastEventId || '0', 10) || 0)) lastEventId = String(offset)
      try { onMessage(JSON.parse(e.data), offset) } catch {}
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
      retryTimer = setTimeout(() => {
        retryTimer = null
        connect()
      }, Math.min(1000 * 2 ** Math.min(retries - 1, 5), 30000))
    }
  }

  connect()
  return {
    connected,
    close: () => {
      closed = true
      resolveConnected()
      if (watchdog) {
        clearTimeout(watchdog)
        watchdog = null
      }
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      es?.close()
      es = null
    },
    setCursor: (cursor: number) => {
      if (!Number.isSafeInteger(cursor) || cursor < 0) return
      lastEventId = String(Math.max(Number.parseInt(lastEventId || '0', 10) || 0, cursor))
      if (!hasConnected && !closed) {
        try { es?.close() } catch {}
        connect()
      }
    },
  }
}

// One /btw exchange: a side question answered from the session's context,
// never written into the transcript.
export interface BtwItem {
  id: string
  question: string
  answer: string
  model: string
  ms: number
  at: string
}

export async function fetchBtw(sessionId: string): Promise<{ items: BtwItem[], pending: boolean }> {
  const response = await fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}/btw`)
  return responseJson(response)
}

export async function askBtw(sessionId: string, question: string): Promise<BtwItem> {
  const response = await fetch(`${BASE}/api/sessions/${encodeURIComponent(sessionId)}/btw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  })
  return responseJson(response)
}

export interface RoomSuccession {
  ok: true
  retiredSessionId: string | null
  leaderSessionId: string
  model: string
  handoff: 'appended' | 'skipped' | 'failed'
  handoffDetail?: string
}

// Retire the Room's Leader (after `room handoff` writes its notes) and seat a
// fresh one. Long call: the handoff distiller can take minutes.
export async function succeedRoomLeader(room: string, options: { model?: string, handoff?: boolean, force?: boolean } = {}): Promise<RoomSuccession> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/leader/succeed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  })
  return responseJson(response)
}

export async function setRoomResidentsPaused(room: string, paused: boolean): Promise<{ paused: boolean, residents: RoomResident[], residentsPaused: boolean }> {
  const response = await fetch(`${BASE}/api/rooms/${encodeURIComponent(room)}/residents/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused }),
  })
  return responseJson(response)
}

// Costs tab: local token ledger plus provider limits.
export interface UsageTotals {
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  costedRequests: number
}

export interface UsageGroup extends UsageTotals {
  lastAt: number
  model?: string
  provider?: string | null
  harness?: string
  room?: string | null
  sessionId?: string | null
}

export interface UsageWindow {
  key: '5h' | '24h' | '7d'
  label: string
  since: string
  totals: UsageTotals
  byModel: UsageGroup[]
  byRoom: UsageGroup[]
  bySession: UsageGroup[]
  byHarness: UsageGroup[]
}

export interface LimitWindow { name: string, utilization: number, resetsAt: string | null }

export interface UsageSnapshot {
  generatedAt: string
  scanMs: number
  files: number
  windows: UsageWindow[]
  providers: {
    anthropic: { windows?: LimitWindow[], tokenSource?: string, tokenExpiresAt?: string | null, error: string | null, lastGoodAt: string | null }
    anthropicApi: { days: { date: string, usd: number }[], todayUsd: number, weekUsd: number, error: string | null, lastGoodAt: string | null } | null
    openrouter: {
      totalCredits?: number, totalUsage?: number, remaining?: number,
      usageDaily?: number, usageWeekly?: number, usageMonthly?: number,
      keyLimit?: number | null, keyLimitRemaining?: number | null,
      error: string | null, lastGoodAt: string | null
    }
    codex: {
      windows: LimitWindow[], observedAt: string | null,
      credits: { hasCredits: boolean, unlimited: boolean, balance: string } | null,
      tokenExpiresAt: string | null, tokenExpired: boolean | null, error: string | null, source?: string
    }
  }
}

export async function fetchUsage(refresh = false): Promise<UsageSnapshot> {
  const response = await fetch(`${BASE}/api/usage${refresh ? '?refresh=1' : ''}`)
  return responseJson(response)
}

// ── Scheduler ───────────────────────────────────────────────────────────────
export interface SchedulerCriterion { type: 'idle' | 'file-changed' | 'file-matches' | 'frontier-has', path?: string, pattern?: string, section?: string, forceAfterMs?: number | null }
export interface SchedulerRule {
  id: string
  room: string
  target: { kind: 'leader' } | { kind: 'resident', role: string } | { kind: 'session', sessionId: string } | { kind: 'new', engine: string, model?: string | null, title?: string | null }
  mode: 'inject' | 'fresh'
  every: string | null
  everyMs: number | null
  cron: string | null
  after: string | null
  when: SchedulerCriterion[]
  prompt: string | null
  timeoutMs: number
  maxRunsPerHour: number
  enabled: boolean
  note: string | null
  targetSessionId: string | null
  lastDecision: string | null
  runtime: {
    lastRunAt: string | null
    lastRunId: string | null
    lastOutcome: string | null
    lastFinishedAt?: string | null
    nextDueAt: string | null
    consecutiveFailures: number
    paused: boolean
    pausedReason: string | null
    overdue: boolean
    running: { runId: string, startedAt: string, sessionId: string | null } | null
  }
}
export interface SchedulerSnapshot { enabled: boolean, bootAt: string, tickMs: number, lastTickAt: string | null, rules: SchedulerRule[] }
export interface SchedulerRun {
  runId: string, ruleId: string, room: string, mode: string, event: 'started' | 'finished', reason: string,
  startedAt: string, finishedAt?: string, durationMs?: number, outcome?: string, detail?: string, sessionId?: string | null
}

export async function fetchScheduler(room?: string | null): Promise<SchedulerSnapshot> {
  return responseJson(await fetch(`${BASE}/api/scheduler${room ? `?room=${encodeURIComponent(room)}` : ''}`))
}
export async function fetchSchedulerRuns(opts: { room?: string | null, limit?: number } = {}): Promise<SchedulerRun[]> {
  const params = new URLSearchParams()
  if (opts.room) params.set('room', opts.room)
  if (opts.limit) params.set('limit', String(opts.limit))
  const query = params.toString()
  return (await responseJson<{ runs: SchedulerRun[] }>(await fetch(`${BASE}/api/scheduler/runs${query ? `?${query}` : ''}`))).runs
}
export async function schedulerRuleAction(ruleId: string, action: 'fire' | 'pause' | 'resume'): Promise<SchedulerRule> {
  return (await responseJson<{ ok: true, rule: SchedulerRule }>(await fetch(`${BASE}/api/scheduler/rules/${ruleId}/${action}`, { method: 'POST' }))).rule
}
export async function deleteSchedulerRule(ruleId: string): Promise<void> {
  await responseJson(await fetch(`${BASE}/api/scheduler/rules/${ruleId}`, { method: 'DELETE' }))
}
