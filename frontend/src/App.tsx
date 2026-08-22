declare const __BUILD_TIME__: string
import { createSignal, createEffect, onMount, onCleanup, Show, For, lazy, Suspense } from 'solid-js'
import { marked } from 'marked'
import { MessageView } from './components/MessageView'
import { SidecarThread } from './components/Sidecar'
import RoomsHome from './RoomsHome'
const Terminal = lazy(() => import('./components/Terminal').then(m => ({ default: m.Terminal })))
import type { SessionMeta, Message, AgentInfo, FileListing, SidecarGroup, RoomUpdate } from './api'
import { fetchSessions, fetchMessages, subscribeMessages, sendInput, createSession, resumeSession, interruptSession, uploadFileWithId, transcribeAudio, deleteSession, renameSession, fetchStarred, saveStarred, exportUrl, fetchAgents, fetchFiles, deletePath, fetchBoxes, fetchSharingPeers, setSessionShare, fetchBuildVersion, fetchSidecars, createSidecar, fetchRooms, fetchRoomUpdates } from './api'
import type { BoxInfo, PeerInfo } from './api'
import { createSpinGestureDetector, motionEventToSpinSample } from './spinGesture'
import { MEDIA_ATTEMPTS, MAX_UPLOAD_BYTES, MAX_AUDIO_BYTES, retryMediaOperation, runMediaOperationOnce, isRetryableVoiceMemo } from './lib/mediaRetry.js'
import { putMediaRecord, patchMediaRecord, deleteMediaRecord, listMediaRecords, isTerminalMediaRecord, withMediaRecordClaim } from './lib/mediaOutbox.js'
import { appUrl } from './lib/appPath.js'
import { localFileUrl } from './lib/localMedia.js'

interface QuickLink { label: string; url: string }

type FileStatus = 'draft' | 'uploading' | 'uploaded' | 'failed'
type VoiceStatus = 'transcribing' | 'failed' | 'delivered'
interface PendingFile { id: string; name: string; blob: Blob; dataUrl: string; isImage: boolean; status: FileStatus; attempts: number; error?: string; serverPath?: string; sessionId: string; boxId: string }
interface VoiceMemo { id: string; name: string; blob: Blob; status: VoiceStatus; attempts: number; error?: string; transcript?: string; intent: 'append' | 'send'; capturedText: string; sessionId: string; boxId: string }
interface SendTarget { id: string; box: string }
interface StoredMediaBase { id: string; boxId: string; sessionId: string; name: string; blob: Blob; attempts: number; error?: string }
interface StoredFileMedia extends StoredMediaBase { kind: 'file' | 'image'; status: FileStatus; serverPath?: string }
interface StoredVoiceMedia extends StoredMediaBase { kind: 'audio'; status: VoiceStatus; transcript?: string; intent?: 'append' | 'send'; capturedText?: string }
type StoredMedia = StoredFileMedia | StoredVoiceMedia

function fileStatusLabel(file: PendingFile) {
  if (file.status === 'uploading') return `Uploading · ${Math.min(MEDIA_ATTEMPTS, file.attempts + 1)}/${MEDIA_ATTEMPTS}`
  if (file.status === 'uploaded') return 'Uploaded'
  return file.error || 'Upload failed'
}

function voiceStatusLabel(memo: VoiceMemo) {
  if (memo.status === 'transcribing') return `Transcribing · ${Math.min(MEDIA_ATTEMPTS, memo.attempts + 1)}/${MEDIA_ATTEMPTS}`
  return memo.error || 'Transcription failed'
}

type SpinGestureState = 'off' | 'requesting' | 'calibrating' | 'ready' | 'triggered' | 'denied' | 'unsupported'
type DeviceMotionPermissionApi = typeof DeviceMotionEvent & { requestPermission?: () => Promise<PermissionState> }
type DeviceOrientationPermissionApi = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<PermissionState> }
type MotionChartPoint = { peakDps: number; degrees: number }
type TossCalibrationStats = { maxPeakDps: number; maxDegrees: number; hits: number }

const MAX_MOTION_CHART_POINTS = 120

function resizeImage(blob: Blob, maxDim = 1600): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const { width: w, height: h } = img
      if (w <= maxDim && h <= maxDim) { resolve(blob); return }
      const scale = Math.min(maxDim / w, maxDim / h)
      const c = document.createElement('canvas')
      c.width = w * scale; c.height = h * scale
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      c.toBlob(b => resolve(b || blob), 'image/png')
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(blob) }
    img.src = url
  })
}

function timeAgo(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// ── Draft persistence ────────────────────────────────────────────────────
function saveDraft(id: string, val: string) {
  if (val) localStorage.setItem(`feather-draft-${id}`, val)
  else localStorage.removeItem(`feather-draft-${id}`)
}
function loadDraft(id: string): string {
  return localStorage.getItem(`feather-draft-${id}`) || ''
}

// ── Input history ────────────────────────────────────────────────────────
const HISTORY_KEY = 'feather-input-history'
const MAX_HISTORY = 50
function getHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') }
  catch { return [] }
}
function pushHistory(text: string) {
  const h = getHistory()
  const idx = h.indexOf(text)
  if (idx >= 0) h.splice(idx, 1)
  h.push(text)
  if (h.length > MAX_HISTORY) h.shift()
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h))
}

// ── Dynamic favicon ──────────────────────────────────────────────────────
function setFavicon(color: string) {
  const size = 32, c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 3, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link) }
  link.href = c.toDataURL()
}

export default function App() {
  const [sessions, setSessions] = createSignal<SessionMeta[]>([])
  const [currentId, setCurrentId] = createSignal<string | null>(null)
  const [boxes, setBoxes] = createSignal<BoxInfo[]>([{ id: 'local', label: 'Local', available: true }])
  const [currentBox, setCurrentBox] = createSignal('local')
  const [peerControl, setPeerControl] = createSignal(false)
  const [sharingPeers, setSharingPeers] = createSignal<PeerInfo[]>([])
  const [messages, setMessages] = createSignal<Message[]>([])
  const [sidebar, setSidebar] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [text, setText] = createSignal('')
  const [tab, setTab] = createSignal<'chat' | 'files' | 'terminal' | 'prompts' | 'updates'>('chat')
  const [updatesList, setUpdatesList] = createSignal<RoomUpdate[]>([])
  const [updatesLoading, setUpdatesLoading] = createSignal(false)
  const [updatesError, setUpdatesError] = createSignal<string | null>(null)
  const [updatesRoomName, setUpdatesRoomName] = createSignal<string | null>(null)
  const [filesMode, setFilesMode] = createSignal<'changed' | 'all'>('changed')
  const [browse, setBrowse] = createSignal<FileListing | null>(null)
  const [browseLoading, setBrowseLoading] = createSignal(false)
  const [browseSort, setBrowseSort] = createSignal<'name' | 'mtime'>(
    (localStorage.getItem('feather-browse-sort') as 'name' | 'mtime') || 'name'
  )
  function setSort(s: 'name' | 'mtime') {
    setBrowseSort(s)
    localStorage.setItem('feather-browse-sort', s)
  }
  const sortedBrowseEntries = () => {
    const b = browse()
    if (!b) return []
    const s = browseSort()
    return [...b.entries].sort((a, c) => {
      if (a.type !== c.type) return a.type === 'dir' ? -1 : 1
      if (s === 'mtime') return c.mtime - a.mtime
      return a.name.localeCompare(c.name)
    })
  }
  async function loadBrowse(dir?: string) {
    setBrowseLoading(true)
    try { setBrowse(await fetchFiles(dir)) }
    catch (e) { console.error(e) }
    finally { setBrowseLoading(false) }
  }
  async function deleteBrowseEntry(full: string, name: string, isDir: boolean) {
    const what = isDir ? `directory "${name}" and ALL its contents` : `"${name}"`
    if (!confirm(`Delete ${what}?\n\n${full}\n\nThis cannot be undone.`)) return
    try {
      await deletePath(full)
      const b = browse()
      if (b) setBrowse({ ...b, entries: b.entries.filter(e => e.name !== name) })
    } catch (e: any) {
      alert(`Delete failed: ${e.message || e}`)
    }
  }
  const [files, setFiles] = createSignal<PendingFile[]>([])
  const [voiceMemos, setVoiceMemos] = createSignal<VoiceMemo[]>([])
  const [mediaNotice, setMediaNotice] = createSignal('')
  let mediaNoticeTimer: ReturnType<typeof setTimeout> | undefined
  function dismissMediaNotice() {
    if (mediaNoticeTimer) clearTimeout(mediaNoticeTimer)
    mediaNoticeTimer = undefined
    setMediaNotice('')
  }
  function showMediaNotice(message: string, autoDismissMs = 0) {
    if (mediaNoticeTimer) clearTimeout(mediaNoticeTimer)
    mediaNoticeTimer = undefined
    setMediaNotice(message)
    if (autoDismissMs > 0) {
      mediaNoticeTimer = setTimeout(() => {
        setMediaNotice(current => current === message ? '' : current)
        mediaNoticeTimer = undefined
      }, autoDismissMs)
    }
  }
  const uploadsInFlight = new Map<string, Promise<string>>()
  const voiceMemosInFlight = new Map<string, Promise<void>>()
  type FileKind = 'image' | 'pdf' | 'md' | 'text'
  function fileKind(p: string): FileKind {
    const ext = p.toLowerCase().split('.').pop() || ''
    if (['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif'].includes(ext)) return 'image'
    if (ext === 'pdf') return 'pdf'
    if (ext === 'md' || ext === 'markdown') return 'md'
    return 'text'
  }
  const [viewingFile, setViewingFile] = createSignal<{ path: string; kind: FileKind; content: string; error?: string } | null>(null)
  async function openFile(path: string) {
    const kind = fileKind(path)
    // Binary types (image/pdf) are rendered directly from the URL by the browser
    // — no need to fetch text content. The 'Open' button also points to the same URL.
    if (kind === 'image' || kind === 'pdf') {
      setViewingFile({ path, kind, content: '' })
      return
    }
    setViewingFile({ path, kind, content: '' })
    try {
      const r = await fetch(localFileUrl(path)!)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      setViewingFile({ path, kind, content: await r.text() })
    } catch (e: any) {
      setViewingFile({ path, kind, content: '', error: e.message || 'failed to load' })
    }
  }
  async function goToPath(rawPath: string) {
    const path = rawPath.replace(/:\d+$/, '')
    setTab('files')
    setBrowseLoading(true)
    try {
      const listing = await fetchFiles(path)
      setBrowse(listing)
      setFilesMode('all')
      setViewingFile(null)
    } catch {
      openFile(path)
    } finally {
      setBrowseLoading(false)
    }
  }
  const [uploading, setUploading] = createSignal(false)
  const [working, setWorking] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [historyIdx, setHistoryIdx] = createSignal(-1)
  const [historyOpen, setHistoryOpen] = createSignal(false)
  const [sseStatus, setSSEStatus] = createSignal<'connected' | 'reconnecting'>('connected')
  const [listening, setListening] = createSignal(false)
  const [interimText, setInterimText] = createSignal('')
  const [recordingTime, setRecordingTime] = createSignal(0)
  const [transcribing, setTranscribing] = createSignal(false)
  const [audioLevel, setAudioLevel] = createSignal(0)
  const [spinGestureState, setSpinGestureState] = createSignal<SpinGestureState>('off')
  const [motionSamples, setMotionSamples] = createSignal(0)
  const [motionPeakDps, setMotionPeakDps] = createSignal(0)
  const [motionDegrees, setMotionDegrees] = createSignal(0)
  const [motionSeries, setMotionSeries] = createSignal<MotionChartPoint[]>([])
  const [tossCalibration, setTossCalibration] = createSignal(false)
  const [tossCalibrationStats, setTossCalibrationStats] = createSignal<TossCalibrationStats>({ maxPeakDps: 0, maxDegrees: 0, hits: 0 })
  const [hasMore, setHasMore] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [renaming, setRenaming] = createSignal(false)
  const [renameText, setRenameText] = createSignal('')
  const [sidebarRenaming, setSidebarRenaming] = createSignal<string | null>(null)
  const [sidebarRenameText, setSidebarRenameText] = createSignal('')
  const [sidebarTab, setSidebarTab] = createSignal<'sessions' | 'links'>('sessions')
  // Session search: non-empty query switches the sidebar list to server-side
  // search results (all sessions, title + content), not just the recent 50.
  const [searchQuery, setSearchQuery] = createSignal('')
  const [searchResults, setSearchResults] = createSignal<SessionMeta[] | null>(null)
  const [searching, setSearching] = createSignal(false)
  let searchDebounce: ReturnType<typeof setTimeout> | undefined
  let searchSeq = 0
  function onSearchInput(q: string) {
    setSearchQuery(q)
    if (searchDebounce) clearTimeout(searchDebounce)
    const trimmed = q.trim()
    if (!trimmed) { setSearchResults(null); setSearching(false); return }
    setSearching(true)
    searchDebounce = setTimeout(async () => {
      const seq = ++searchSeq
      try {
        const r = await fetchSessions(currentBox(), trimmed)
        if (seq === searchSeq) setSearchResults(r.sessions)
      } catch {
        if (seq === searchSeq) setSearchResults([])
      } finally {
        if (seq === searchSeq) setSearching(false)
      }
    }, 350)
  }
  function clearSearch() {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchSeq++
    setSearchQuery('')
    setSearchResults(null)
    setSearching(false)
  }
  // Sidecars are surfaced nested under their driver session (not a separate tab).
  const [sidecars, setSidecars] = createSignal<SidecarGroup[]>([])
  const [openSidecarId, setOpenSidecarId] = createSignal<string | null>(null)
  const refreshSidecars = async () => { try { setSidecars((await fetchSidecars()).groups || []) } catch {} }
  onMount(() => { refreshSidecars(); const t = setInterval(refreshSidecars, 5000); onCleanup(() => clearInterval(t)) })
  // A group belongs to the session that drives it (the non-spawned member),
  // matched by 8-char tmux prefix so CLI- and GUI-created groups both attach.
  const sidecarsForSession = (sid: string) =>
    sidecars().filter(g => g.status === 'active' && g.members.some(m => !m.spawned && m.sessionId.slice(0, 8) === sid.slice(0, 8)))
  async function spawnSidecarFor(sid: string) {
    const task = prompt('Task / opening message for the sidecar (optional):') ?? ''
    const agent = (prompt('Agent for the peer (claude / codex):', 'claude') || 'claude').trim()
    try { const r = await createSidecar(sid, { task, agent }); await refreshSidecars(); setOpenSidecarId(r.group.id) }
    catch (e: any) { alert('Failed to spawn sidecar: ' + (e?.message || e)) }
  }
  const [links, setLinks] = createSignal<QuickLink[]>([])
  const [starred, setStarred] = createSignal<Record<string, string[]>>({})
  const [expanded, setExpanded] = createSignal(false)
  const [agents, setAgents] = createSignal<AgentInfo[]>([])
  const [agentDropdown, setAgentDropdown] = createSignal(false)
  let cleanupSSE: (() => void) | null = null
  let sessionPoll: ReturnType<typeof setInterval> | undefined
  let versionPoll: ReturnType<typeof setInterval> | undefined
  let bootVersion: string | null = null
  let mediaRecorder: MediaRecorder | null = null
  let audioChunks: Blob[] = []
  let audioContext: AudioContext | null = null
  let mediaStream: MediaStream | null = null
  let recordingTimer: ReturnType<typeof setInterval> | null = null
  let levelTimer: ReturnType<typeof requestAnimationFrame> | null = null
  let analyser: AnalyserNode | null = null
  const spinDetector = createSpinGestureDetector()
  let motionListener: ((event: DeviceMotionEvent) => void) | null = null
  let spinSendAfterStop = false
  let tossCalibrationHitActive = false
  let textareaRef: HTMLTextAreaElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let dragCounter = 0
  let mediaRestoreGeneration = 0

  // Swipe gesture state
  let touchStartX = 0
  let touchStartY = 0
  let touchTracking = false

  function onTouchStart(e: TouchEvent) {
    const t = e.touches[0]
    touchStartX = t.clientX
    touchStartY = t.clientY
    touchTracking = sidebar() || touchStartX < 30
  }
  function onTouchEnd(e: TouchEvent) {
    if (!touchTracking) return
    const t = e.changedTouches[0]
    const dx = t.clientX - touchStartX
    const dy = Math.abs(t.clientY - touchStartY)
    if (dy > Math.abs(dx)) return
    if (!sidebar() && dx > 60) openSidebar()
    if (sidebar() && dx < -60) setSidebar(false)
    touchTracking = false
  }


  async function addFiles(fileList: FileList | File[]) {
    if (uploading()) return
    const sessionId = currentId()
    const boxId = currentBox()
    if (!sessionId) return
    const added: PendingFile[] = []
    for (const f of fileList) {
      if (f.size > MAX_UPLOAD_BYTES) {
        setMediaNotice(`${f.name} is larger than the 50 MB upload limit.`)
        continue
      }
      const isImage = f.type.startsWith('image/')
      const blob = isImage ? await resizeImage(f) : f
      const dataUrl = URL.createObjectURL(blob)
      const id = crypto.randomUUID()
      const record = { id, boxId, sessionId, kind: isImage ? 'image' : 'file', name: f.name, mimeType: blob.type, blob, status: 'draft', attempts: 0, createdAt: Date.now() }
      try { await putMediaRecord(record) }
      catch (e: any) { setMediaNotice(`Recovery storage unavailable: ${e?.message || e}. Keep this tab open or remove/download the file.`) }
      if (currentId() === sessionId && currentBox() === boxId) {
        added.push({ id, name: f.name, blob, dataUrl, isImage, status: 'draft', attempts: 0, sessionId, boxId })
      } else {
        URL.revokeObjectURL(dataUrl)
      }
    }
    if (currentId() === sessionId && currentBox() === boxId) setFiles(prev => [...prev, ...added])
  }

  async function removeFile(idx: number) {
    if (uploading()) return
    const file = files()[idx]
    if (!file) return
    URL.revokeObjectURL(file.dataUrl)
    await deleteMediaRecord(file.id).catch(() => {})
    setFiles(prev => prev.filter((_, i) => i !== idx))
  }

  function updateFile(id: string, patch: Partial<PendingFile>) {
    setFiles(prev => prev.map(file => file.id === id ? { ...file, ...patch } : file))
  }

  function updateVoice(id: string, patch: Partial<VoiceMemo>) {
    setVoiceMemos(prev => prev.map(memo => memo.id === id ? { ...memo, ...patch } : memo))
  }

  function clearPendingMedia() {
    for (const file of files()) URL.revokeObjectURL(file.dataUrl)
    setFiles([])
    setVoiceMemos([])
  }

  async function restoreMedia(boxId: string, sessionId: string) {
    const generation = ++mediaRestoreGeneration
    clearPendingMedia()
    try {
      const records = await listMediaRecords(boxId, sessionId) as StoredMedia[]
      if (generation !== mediaRestoreGeneration || currentBox() !== boxId || currentId() !== sessionId) return
      const recoverable = records.filter(record => !isTerminalMediaRecord(record))
      const attachments = recoverable.filter(r => r.kind === 'file' || r.kind === 'image').map(r => ({
        id: r.id, name: r.name, blob: r.blob, dataUrl: URL.createObjectURL(r.blob), isImage: r.kind === 'image',
        status: r.status === 'uploading' ? 'failed' : r.status, attempts: r.attempts || 0,
        error: r.status === 'uploading' ? 'Interrupted before upload completed' : r.error,
        serverPath: r.serverPath, sessionId, boxId,
      }))
      const memos = recoverable.filter(r => r.kind === 'audio').map(r => ({
        id: r.id, name: r.name, blob: r.blob, status: r.status === 'transcribing' ? 'failed' : r.status,
        attempts: r.attempts || 0, error: r.status === 'transcribing' ? 'Interrupted before transcription completed' : r.error,
        transcript: r.transcript, intent: r.intent || 'append', capturedText: r.capturedText || '', sessionId, boxId,
      }))
      setFiles(attachments); setVoiceMemos(memos)
      if (recoverable.length) setMediaNotice(`Recovered ${recoverable.length} unsent media item${recoverable.length === 1 ? '' : 's'}.`)
      queueMicrotask(() => retryRecoverableMedia())
    } catch (e: any) {
      setMediaNotice(`Media recovery unavailable: ${e?.message || e}`)
    }
  }

  function onGlobalKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      const s = cur()
      if (s?.isActive) handleInterrupt(s.id)
    }
    // After Send the composer is blurred (dismissing the keyboard/iPad floating bar).
    // The first printable keystroke on a hardware keyboard re-focuses it and captures
    // the character, so typing resumes seamlessly without tapping the field again.
    if (tab() === 'chat' && currentId() && textareaRef &&
        document.activeElement !== textareaRef &&
        e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
      const ae = document.activeElement as HTMLElement | null
      const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
      if (!editable) {
        e.preventDefault()
        textareaRef.focus()
        setText(text() + e.key)
        textareaRef.style.height = 'auto'
        textareaRef.style.height = Math.min(textareaRef.scrollHeight, 120) + 'px'
      }
    }
  }

  function onOpenPath(e: Event) {
    const detail = (e as CustomEvent).detail
    if (detail && typeof detail.path === 'string') goToPath(detail.path)
  }
  onMount(async () => {
    document.addEventListener('keydown', onGlobalKeyDown)
    fetchBoxes().then(setBoxes).catch(() => {})
    fetchSharingPeers().then(r => setSharingPeers(r.peers)).catch(() => {})
    // Hash may carry a box prefix: #boxid:sessionid
    const hash = location.hash.slice(1)
    const boxMatch = hash.match(/^([a-z0-9_-]+):(.+)$/i)
    if (boxMatch) setCurrentBox(boxMatch[1])
    await refreshSessions()
    fetchAgents().then(setAgents).catch(() => {})
    fetch(appUrl('/api/quick-links')).then(r => r.json()).then(setLinks).catch(() => {})
    fetchStarred().then(setStarred).catch(() => {})
    if (boxMatch) select(boxMatch[2])
    else if (hash) select(hash)
    // Refresh session list when tab becomes visible
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', retryRecoverableMedia)
    window.addEventListener('feather:open-path', onOpenPath)
    // Poll the session list so active/idle (green dot) status stays fresh
    // without needing a manual action. Skip while the tab is hidden.
    sessionPoll = setInterval(() => { if (document.visibilityState === 'visible') refreshSessions() }, 15000)
    // Auto-reload when a newer build is deployed. A resident client (esp. an
    // installed iOS PWA) keeps the old JS in memory across suspend/resume and
    // never re-fetches index.html, so a stale bundle — e.g. one without the
    // session poll above — silently shows stale green dots and ordering. Poll
    // the server's build version and reload once when it changes.
    fetchBuildVersion().then(v => { bootVersion = v })
    versionPoll = setInterval(checkVersion, 60000)
    document.addEventListener('visibilitychange', checkVersion)
    // Prefetch Terminal chunk during idle so the tab click feels instant
    const idle = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 2000))
    idle(() => { import('./components/Terminal').catch(() => {}) })
  })
  function onVisibility() {
    if (document.visibilityState === 'visible') refreshSessions()
  }
  async function checkVersion() {
    if (document.visibilityState !== 'visible') return
    const v = await fetchBuildVersion()
    if (!v) return
    if (bootVersion === null) { bootVersion = v; return }
    // A newer build is live. Reload to pull the latest bundle so this client
    // stops running stale JS.
    if (v !== bootVersion) location.reload()
  }
  onCleanup(() => { if (mediaNoticeTimer) clearTimeout(mediaNoticeTimer); clearPendingMedia(); cleanupSSE?.(); if (sessionPoll) clearInterval(sessionPoll); if (versionPoll) clearInterval(versionPoll); document.removeEventListener('keydown', onGlobalKeyDown); document.removeEventListener('visibilitychange', onVisibility); document.removeEventListener('visibilitychange', checkVersion); window.removeEventListener('online', retryRecoverableMedia); window.removeEventListener('feather:open-path', onOpenPath) })

  const isPeerBox = () => !!boxes().find(b => b.id === currentBox())?.peer
  const isRemoteBox = () => currentBox() !== 'local'
  // On a peer box we can only type if the peer granted us control
  const canSend = () => !isPeerBox() || peerControl()

  async function refreshSessions() {
    try {
      const r = await fetchSessions(currentBox())
      setSessions(r.sessions)
      if (isPeerBox()) setPeerControl(!!r.control)
    } catch {}
  }

  function selectBox(id: string) {
    if (id === currentBox()) return
    dismissMediaNotice()
    setCurrentBox(id)
    setPeerControl(false)
    clearSearch()
    setCurrentId(null)
    cleanupSSE?.()
    setMessages([])
    clearPendingMedia()
    setTab('chat')
    location.hash = ''
    setSessions([])
    refreshSessions()
  }

  async function select(id: string) {
    const prev = currentId()
    if (prev) saveDraft(prev, text())
    dismissMediaNotice()
    setCurrentId(id)
    location.hash = currentBox() === 'local' ? id : `${currentBox()}:${id}`
    setSidebar(false)
    setLoading(true)
    setMessages([])
    setWorking(false)
    setText(loadDraft(id))
    restoreMedia(currentBox(), id)
    setHistoryIdx(-1)
    setHistoryOpen(false)
    cleanupSSE?.()
    try {
      const result = await fetchMessages(id, 0, currentBox())
      setMessages(result.messages)
      setHasMore(result.hasMore)
    } catch {}
    setLoading(false)
    setSSEStatus('connected')
    cleanupSSE = subscribeMessages(id, (msg) => {
      if (msg.role === 'assistant') setWorking(false)
      setMessages(prev => {
        if (prev.some(m => m.uuid === msg.uuid)) return prev
        if (msg.role === 'user') {
          const msgText = msg.content?.find(b => b.type === 'text')?.text || ''
          const idx = prev.findIndex(m =>
            m.uuid.startsWith('optimistic-') &&
            m.content?.[0]?.text === msgText &&
            Math.abs(new Date(m.timestamp).getTime() - new Date(msg.timestamp).getTime()) < 30000
          )
          if (idx >= 0) {
            const updated = [...prev]
            updated[idx] = { ...msg, delivery: 'delivered' }
            return updated
          }
        }
        return [...prev, msg]
      })
    }, setSSEStatus, currentBox())
  }

  async function handleNew(agent?: string) {
    setCreating(true)
    setAgentDropdown(false)
    try {
      const id = await createSession(undefined, agent)
      select(id)
      refreshSessions()
    } catch (e) { console.error(e) }
    finally { setCreating(false) }
  }

  async function handleResume(id: string) {
    await resumeSession(id)
    await refreshSessions()
    select(id)
  }

  async function handleInterrupt(id: string) {
    await interruptSession(id, currentBox())
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this session?')) return
    setMenuOpen(false)
    await deleteSession(id)
    dismissMediaNotice()
    setCurrentId(null)
    location.hash = ''
    cleanupSSE?.()
    setMessages([])
    await refreshSessions()
  }

  async function handleRename(id: string) {
    const title = renameText().trim()
    if (!title) { setRenaming(false); return }
    await renameSession(id, title)
    setRenaming(false)
    setMenuOpen(false)
    await refreshSessions()
  }

  async function handleShare(id: string) {
    setMenuOpen(false)
    const current = sessions().find(s => s.id === id)?.share || []
    const available = sharingPeers().map(p => p.id)
    const input = prompt(`Share this session with which peers?\nAvailable: ${available.join(', ')} (comma-separated, empty to unshare)`, current.join(', '))
    if (input === null) return
    const peers = input.split(',').map(s => s.trim()).filter(Boolean)
    const unknown = peers.filter(p => !available.includes(p))
    if (unknown.length) { alert(`Unknown peer(s): ${unknown.join(', ')}`); return }
    await setSessionShare(id, peers)
    await refreshSessions()
  }

  function goHome() {
    dismissMediaNotice()
    setCurrentId(null)
    location.hash = ''
    setSidebar(false)
    cleanupSSE?.()
    setMessages([])
    clearPendingMedia()
  }

  function openSidebar() {
    setSidebar(true)
    // Refresh the session list so sessions created since page load appear without a reload
    refreshSessions()
  }

  async function handleSidebarRename(id: string) {
    const title = sidebarRenameText().trim()
    if (!title) { setSidebarRenaming(null); return }
    await renameSession(id, title)
    setSidebarRenaming(null)
    await refreshSessions()
  }

  async function loadEarlier() {
    const id = currentId()
    if (!id || loadingMore()) return
    setLoadingMore(true)
    try {
      const result = await fetchMessages(id, messages().length, currentBox())
      setMessages(prev => [...result.messages, ...prev])
      setHasMore(result.hasMore)
    } catch {}
    setLoadingMore(false)
  }

  async function toggleStar(sessionId: string, msgUuid: string) {
    const s = { ...starred() }
    const list = s[sessionId] || []
    const idx = list.indexOf(msgUuid)
    if (idx >= 0) list.splice(idx, 1)
    else list.push(msgUuid)
    s[sessionId] = list.filter(Boolean)
    if (s[sessionId].length === 0) delete s[sessionId]
    setStarred(s)
    saveStarred(s).catch(() => {})
  }

  async function requestMotionAccess(): Promise<'granted' | 'denied' | 'unsupported'> {
    if (!window.isSecureContext || !('DeviceMotionEvent' in window)) return 'unsupported'
    const MotionEventCtor = window.DeviceMotionEvent as DeviceMotionPermissionApi
    const OrientationEventCtor = (window as any).DeviceOrientationEvent as DeviceOrientationPermissionApi | undefined
    try {
      if (typeof MotionEventCtor.requestPermission === 'function') {
        return await MotionEventCtor.requestPermission() === 'granted' ? 'granted' : 'denied'
      }
      if (OrientationEventCtor && typeof OrientationEventCtor.requestPermission === 'function') {
        return await OrientationEventCtor.requestPermission() === 'granted' ? 'granted' : 'denied'
      }
      return 'granted'
    } catch {
      return 'denied'
    }
  }

  function stopSpinGesture(nextState: SpinGestureState = 'off') {
    if (motionListener) {
      window.removeEventListener('devicemotion', motionListener)
      motionListener = null
    }
    spinDetector.reset()
    setMotionSamples(0)
    setMotionPeakDps(0)
    setMotionDegrees(0)
    setSpinGestureState(nextState)
  }

  function resetTossCalibrationStats() {
    tossCalibrationHitActive = false
    setTossCalibrationStats({ maxPeakDps: 0, maxDegrees: 0, hits: 0 })
  }

  function toggleTossCalibration() {
    const next = !tossCalibration()
    setTossCalibration(next)
    if (next) resetTossCalibrationStats()
    else {
      tossCalibrationHitActive = false
      spinDetector.reset()
      setSpinGestureState(listening() ? 'calibrating' : 'off')
    }
  }

  function updateTossCalibration(result: { peakDps: number; integratedDegrees: number }, hit = false) {
    const peakDps = Math.round(result.peakDps)
    const degrees = Math.round(result.integratedDegrees)
    setTossCalibrationStats(stats => ({
      maxPeakDps: Math.max(stats.maxPeakDps, peakDps),
      maxDegrees: Math.max(stats.maxDegrees, degrees),
      hits: stats.hits + (hit ? 1 : 0),
    }))
  }

  function tossCalibrationSummary() {
    const stats = tossCalibrationStats()
    return `max p${stats.maxPeakDps} d${stats.maxDegrees}${stats.hits ? ` · hit ${stats.hits}` : ''}`
  }

  function stopVoiceForSpinSend() {
    if (!listening() || spinSendAfterStop) return
    spinSendAfterStop = true
    setSpinGestureState('triggered')
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop()
    else stopVoice()
  }

  function startSpinGesture() {
    stopSpinGesture('calibrating')
    motionListener = (event: DeviceMotionEvent) => {
      const calibratingToss = tossCalibration()
      const result = spinDetector.sample(motionEventToSpinSample(event, performance.now()), { commitTrigger: !calibratingToss })
      setMotionSamples(n => n + 1)
      setMotionPeakDps(Math.round(result.peakDps))
      setMotionDegrees(Math.round(result.integratedDegrees))
      setMotionSeries(points => [...points, { peakDps: result.peakDps, degrees: result.integratedDegrees }].slice(-MAX_MOTION_CHART_POINTS))
      if (calibratingToss) {
        const hit = result.triggered && !tossCalibrationHitActive
        updateTossCalibration(result, hit)
        tossCalibrationHitActive = result.triggered
      }
      if (result.status === 'calibrating') setSpinGestureState('calibrating')
      else if (result.status === 'armed') setSpinGestureState('ready')
      if (result.triggered) {
        if (calibratingToss) return
        stopVoiceForSpinSend()
      }
    }
    window.addEventListener('devicemotion', motionListener, { passive: true })
  }

  function voiceTitle() {
    if (transcribing()) return 'Transcribing...'
    if (!listening()) return 'Record voice memo (max 25 MB)'
    if (spinGestureState() === 'calibrating') return 'Stop & transcribe (motion calibrating)'
    if (spinGestureState() === 'ready') return 'Stop & transcribe (motion armed)'
    if (spinGestureState() === 'triggered') return 'Stopping & sending...'
    if (spinGestureState() === 'denied') return 'Stop & transcribe (motion denied)'
    return 'Stop & transcribe'
  }

  function recordingPlaceholder() {
    if (transcribing()) return 'Transcribing...'
    if (!listening()) return 'Send a message...'
    const elapsed = `${Math.floor(recordingTime() / 60)}:${(recordingTime() % 60).toString().padStart(2, '0')}`
    if (spinGestureState() === 'unsupported') return `Recording ${elapsed} · motion unsupported`
    if (spinGestureState() === 'denied') return `Recording ${elapsed} · motion denied`
    if (spinGestureState() === 'requesting') return `Recording ${elapsed} · motion requesting`
    if (tossCalibration()) return `Recording ${elapsed} · toss cal · p${motionPeakDps()} d${motionDegrees()} · ${tossCalibrationSummary()}`
    if (spinGestureState() === 'calibrating') return `Recording ${elapsed} · motion calibrating · ${motionSamples()}`
    if (spinGestureState() === 'ready') return `Recording ${elapsed} · motion ready · p${motionPeakDps()} d${motionDegrees()}`
    if (spinGestureState() === 'triggered') return `Recording ${elapsed} · motion triggered`
    return `Recording ${elapsed}`
  }

  function motionChartPoints(key: keyof MotionChartPoint, maxValue: number) {
    const points = motionSeries()
    if (points.length === 0) return ''
    const width = 100
    const height = 32
    const denom = Math.max(1, points.length - 1)
    return points.map((point, index) => {
      const x = (index / denom) * width
      const y = height - Math.min(1, point[key] / maxValue) * (height - 3) - 1
      return `${x.toFixed(2)},${y.toFixed(2)}`
    }).join(' ')
  }

  function showMotionChart() {
    return (listening() || transcribing()) && motionSeries().length > 0
  }

  function stopVoice() {
    setListening(false)
    setRecordingTime(0)
    setAudioLevel(0)
    setInterimText('')
    setTossCalibration(false)
    resetTossCalibrationStats()
    stopSpinGesture()
    spinSendAfterStop = false
    if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null }
    if (levelTimer) { cancelAnimationFrame(levelTimer); levelTimer = null }
    if (audioContext) { audioContext.close(); audioContext = null }
    analyser = null
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null }
    mediaRecorder = null
    audioChunks = []
  }

  async function persistMediaPatch(id: string, patch: Record<string, unknown>) {
    await patchMediaRecord(id, patch).catch((e: any) => setMediaNotice(`Could not update recovery storage: ${e?.message || e}`))
  }

  function uploadPendingFile(file: PendingFile): Promise<string> {
    return runMediaOperationOnce(uploadsInFlight, file.id, async () => {
      if (file.serverPath) return file.serverPath
      updateFile(file.id, { status: 'uploading', error: undefined })
      await persistMediaPatch(file.id, { status: 'uploading', error: null })
      let lastAttempt = file.attempts
      try {
        const path = await retryMediaOperation(
          () => uploadFileWithId(file.blob, file.name, file.id, AbortSignal.timeout(90_000)),
          { onAttempt: async (attempt, error: any, willRetry: boolean) => {
            lastAttempt = attempt
            if (willRetry) {
              const patch = { status: 'uploading' as const, attempts: attempt, error: error?.message || String(error) }
              updateFile(file.id, patch)
              await persistMediaPatch(file.id, patch)
            }
          } },
        )
        updateFile(file.id, { status: 'uploaded', serverPath: path, error: undefined })
        await persistMediaPatch(file.id, { status: 'uploaded', serverPath: path, error: null })
        return path
      } catch (error: any) {
        const patch = { status: 'failed' as const, attempts: lastAttempt, error: error?.message || String(error) }
        updateFile(file.id, patch)
        await persistMediaPatch(file.id, patch)
        throw error
      }
    })
  }

  function processVoiceMemo(memo: VoiceMemo): Promise<void> {
    return runMediaOperationOnce(voiceMemosInFlight, memo.id, () => withMediaRecordClaim(memo.id, async () => {
      let transcript = memo.transcript
      let lastAttempt = memo.attempts
      if (!transcript && memo.blob.size < 1000) return
      try {
        if (!transcript) {
          updateVoice(memo.id, { status: 'transcribing', error: undefined })
          await persistMediaPatch(memo.id, { status: 'transcribing', error: null })
          transcript = await retryMediaOperation(
            () => transcribeAudio(memo.blob, AbortSignal.timeout(120_000)),
            { onAttempt: async (attempt, error: any, willRetry: boolean) => {
              lastAttempt = attempt
              if (willRetry) {
                const patch = { status: 'transcribing' as const, attempts: attempt, error: error?.message || String(error) }
                updateVoice(memo.id, patch)
                await persistMediaPatch(memo.id, patch)
              }
            } },
          )
          updateVoice(memo.id, { transcript })
          await persistMediaPatch(memo.id, { transcript })
        }
        if (memo.intent === 'send') {
          await sendSessionText([memo.capturedText, transcript].filter(Boolean).join(' '), { id: memo.sessionId, box: memo.boxId }, memo.id)
          const draft = memo.sessionId === currentId() && memo.boxId === currentBox() ? text() : loadDraft(memo.sessionId)
          if (draft === memo.capturedText) {
            saveDraft(memo.sessionId, '')
            if (memo.sessionId === currentId() && memo.boxId === currentBox()) setText('')
          }
        } else {
          const previous = memo.sessionId === currentId() && memo.boxId === currentBox() ? text().trim() : loadDraft(memo.sessionId).trim()
          const next = [previous, transcript].filter(Boolean).join(' ')
          saveDraft(memo.sessionId, next)
          if (memo.sessionId === currentId() && memo.boxId === currentBox()) setText(next)
        }
        // Keep a tiny terminal tombstone after acknowledgement. It prevents a
        // stale second tab from replaying the memo even when Blob cleanup fails.
        await patchMediaRecord(memo.id, { status: 'delivered', error: null, deliveredAt: Date.now(), blob: new Blob([], { type: memo.blob.type }) })
        setVoiceMemos(prev => prev.filter(item => item.id !== memo.id))
        if (memo.sessionId === currentId() && memo.boxId === currentBox()) {
          showMediaNotice('Voice memo recovered successfully.', 4000)
        }
      } catch (error: any) {
        const message = error?.message || String(error)
        const patch = { status: 'failed' as const, attempts: lastAttempt, error: message, transcript }
        updateVoice(memo.id, patch)
        await persistMediaPatch(memo.id, patch)
        if (memo.sessionId === currentId() && memo.boxId === currentBox()) {
          showMediaNotice(`Voice memo retained: ${message}`)
        }
      }
    })) as Promise<void>
  }

  async function retryRecoverableMedia() {
    if (!navigator.onLine) return
    for (const file of files().filter(item => item.status === 'failed')) uploadPendingFile(file).catch(() => {})
    for (const memo of voiceMemos().filter(isRetryableVoiceMemo)) processVoiceMemo(memo)
  }

  function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = name; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function removeVoiceMemo(id: string) {
    const memo = voiceMemos().find(item => item.id === id)
    if (memo) await deleteMediaRecord(id).catch(() => {})
    setVoiceMemos(prev => prev.filter(item => item.id !== id))
  }

  async function toggleVoice() {
    if (listening()) {
      // Stop recording and transcribe
      spinSendAfterStop = false
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop()
      } else {
        stopVoice()
      }
      return
    }

    const recordingTarget = { sessionId: currentId()!, boxId: currentBox(), capturedText: text() }
    setSpinGestureState('requesting')
    setMotionSeries([])
    setTossCalibration(false)
    resetTossCalibrationStats()
    const motionAccess = await requestMotionAccess()
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      setSpinGestureState('off')
      return
    }

    audioChunks = []
    setListening(true)
    setRecordingTime(0)
    if (motionAccess === 'granted') startSpinGesture()
    else setSpinGestureState(motionAccess)

    // Timer
    const start = Date.now()
    recordingTimer = setInterval(() => setRecordingTime(Math.floor((Date.now() - start) / 1000)), 200)

    // Audio level meter
    audioContext = new AudioContext()
    const source = audioContext.createMediaStreamSource(mediaStream)
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    function updateLevel() {
      if (!analyser) return
      analyser.getByteFrequencyData(dataArray)
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length
      setAudioLevel(avg / 255)
      levelTimer = requestAnimationFrame(updateLevel)
    }
    updateLevel()

    // Record
    const supportedMime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type))
    try { mediaRecorder = supportedMime ? new MediaRecorder(mediaStream, { mimeType: supportedMime }) : new MediaRecorder(mediaStream) }
    catch (e: any) { stopVoice(); setMediaNotice(`Recording is unsupported: ${e?.message || e}`); return }
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data) }
    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: mediaRecorder!.mimeType })
      const sendAfterTranscription = spinSendAfterStop
      const { sessionId, boxId, capturedText } = recordingTarget
      const id = crypto.randomUUID()
      const name = `voice-memo-${Date.now()}.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`
      const sizeError = blob.size > MAX_AUDIO_BYTES ? 'Voice memo is larger than the 25 MB audio limit' : blob.size < 1000 ? 'Recording was too short to transcribe' : null
      const record = { id, kind: 'audio', name, mimeType: blob.type, blob, status: sizeError ? 'failed' : 'transcribing', attempts: 0, error: sizeError, intent: sendAfterTranscription ? 'send' : 'append', capturedText, sessionId, boxId, createdAt: Date.now() }
      try { await putMediaRecord(record) }
      catch (e: any) { setMediaNotice(`Voice recovery storage unavailable: ${e?.message || e}. Download the memo before closing this tab.`) }
      const memo: VoiceMemo = { ...record, status: record.status as VoiceStatus, error: record.error || undefined, intent: record.intent as 'append' | 'send' }
      if (sessionId === currentId() && boxId === currentBox()) setVoiceMemos(prev => [...prev, memo])
      stopVoice()
      if (sizeError) return
      setTranscribing(true)
      try { await processVoiceMemo(memo) }
      finally { setTranscribing(false) }
    }
    mediaRecorder.onerror = (event: any) => {
      setMediaNotice(`Recording failed: ${event?.error?.message || 'unknown recorder error'}`)
      // Stopping drives onstop, which durably saves any chunks the recorder did
      // manage to produce instead of abandoning them in memory.
      if (mediaRecorder?.state === 'recording') mediaRecorder.stop()
    }
    mediaRecorder.start(1000) // collect chunks every second
  }

  async function sendSessionText(rawText: string, target: SendTarget, messageId?: string) {
    const fullText = rawText.trim()
    if (!fullText) return
    const { id: targetId, box: targetBox } = target
    const targetIsCurrent = targetId === currentId() && targetBox === currentBox()
    const targetIsPeer = !!boxes().find(box => box.id === targetBox)?.peer
    let tempId: string | undefined

    // No optimistic echo on peer boxes: the owner's server prefixes our name
    // ([allan] …), so the streamed-back text wouldn't match and we'd show a dupe
    if (!targetIsPeer && targetIsCurrent) {
      tempId = `optimistic-${Date.now()}`
      setMessages(prev => [...prev, { uuid: tempId!, role: 'user', timestamp: new Date().toISOString(), content: [{ type: 'text', text: fullText }], delivery: 'sent' }])
    }
    try { await sendInput(targetId, fullText, targetBox, messageId) }
    catch (error) {
      if (tempId) setMessages(prev => prev.filter(message => message.uuid !== tempId))
      throw error
    }
    pushHistory(fullText)
    if (targetIsCurrent) setWorking(true)
  }

  async function sendComposedMessage(rawText: string, pending: PendingFile[] = files()) {
    const val = rawText.trim()
    if ((!val && !pending.length) || !currentId()) return
    const targetId = currentId()!
    const targetBox = currentBox()
    setUploading(true)
    setMediaNotice('')
    try {
      const parts: string[] = val ? [val] : []
      for (const f of pending) {
        const uploadPath = await uploadPendingFile(f)
        parts.push(f.isImage ? `[Attached image: ${uploadPath}]` : `[Attached file: ${uploadPath}] (${f.name})`)
      }
      // Reuse the first durable attachment id as the delivery key. If the
      // server accepted the prompt but its acknowledgement was lost, Retry
      // receives the same success response without injecting it twice.
      await sendSessionText(parts.join('\n'), { id: targetId, box: targetBox }, pending[0]?.id)
      for (const f of pending) {
        URL.revokeObjectURL(f.dataUrl)
        await deleteMediaRecord(f.id).catch(() => {})
      }
      if (targetId === currentId() && targetBox === currentBox()) {
        if (text() === rawText) { setText(''); saveDraft(targetId, '') }
        setFiles(prev => prev.filter(file => !pending.some(sent => sent.id === file.id)))
        if (textareaRef) { textareaRef.style.height = 'auto'; textareaRef.blur() }
      }
    } catch (e: any) {
      if (targetId === currentId() && targetBox === currentBox()) setMediaNotice(`Media retained — ${e?.message || e}. Retry when ready.`)
    } finally { setUploading(false) }
  }

  async function handleSend() {
    if (listening()) { stopVoiceForSpinSend(); return }
    await sendComposedMessage(text(), files())
  }

  const cur = () => sessions().find(s => s.id === currentId())

  createEffect(() => {
    const s = cur()
    if (!s) setFavicon('#333')
    else if (s.isActive) setFavicon('#4aba6a')
    else setFavicon('#666')
  })

  createEffect(() => {
    if (tab() === 'files' && filesMode() === 'all' && !browse() && !browseLoading()) loadBrowse()
  })

  function formatSize(n: number): string {
    if (n < 1024) return n + 'B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'K'
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + 'M'
    return (n / (1024 * 1024 * 1024)).toFixed(2) + 'G'
  }

  function formatRelTime(ms: number): string {
    const diff = (Date.now() - ms) / 1000
    if (diff < 60) return 'now'
    if (diff < 3600) return Math.floor(diff / 60) + 'm'
    if (diff < 86400) return Math.floor(diff / 3600) + 'h'
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + 'd'
    if (diff < 86400 * 365) return Math.floor(diff / (86400 * 30)) + 'mo'
    return Math.floor(diff / (86400 * 365)) + 'y'
  }

  const touchedFiles = () => {
    const files = new Map<string, { actions: Set<string>, lastSeen: string }>()
    for (const msg of messages()) {
      for (const block of msg.content || []) {
        if (block.type !== 'tool_use') continue
        // Only use file_path (Read/Write/Edit) — not path (Grep/Glob search dirs)
        const fp = block.input?.file_path
        if (typeof fp === 'string' && fp.startsWith('/')) {
          const existing = files.get(fp)
          if (existing) { existing.actions.add(block.name || 'tool'); existing.lastSeen = msg.timestamp }
          else files.set(fp, { actions: new Set([block.name || 'tool']), lastSeen: msg.timestamp })
        }
      }
    }
    return [...files.entries()]
      .map(([path, { actions, lastSeen }]) => ({ path, actions: [...actions], lastSeen }))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
  }

  const tabStyle = (t: string) => ({
    padding: '6px 16px', border: 'none', 'border-bottom': tab() === t ? '2px solid #4aba6a' : '2px solid transparent',
    background: 'none', color: tab() === t ? '#e5e5e5' : '#666', 'font-size': '13px', 'font-weight': '600', cursor: 'pointer',
    '-webkit-tap-highlight-color': 'transparent',
  })
  // Prompts tab: just the user's own inputs, scrollable back through history.
  // A "prompt" is a user message carrying real text (excludes tool_result-only
  // user turns, which are tool output fed back to the agent, not asks).
  const userPrompts = () => messages().filter(m => m.role === 'user' && (m.content || []).some(b => b.type === 'text' && (b.text || '').trim()))
  const promptText = (m: Message) => (m.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n').trim()
  const fmtFeedTime = (ts: string | null | undefined) => {
    if (!ts) return ''
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }
  let promptsScroller: HTMLDivElement | undefined
  // Open the Prompts tab already scrolled to the latest ask, so "scroll back"
  // walks into history. Only fires on tab switch, never fights a manual scroll.
  createEffect(() => {
    if (tab() !== 'prompts') return
    const el = promptsScroller
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  })
  // Updates tab: the containing Room's human-facing feed. A session carries no
  // room name, so resolve it from the rooms snapshot, then load that feed.
  async function loadSessionUpdates(id: string) {
    setUpdatesLoading(true); setUpdatesError(null); setUpdatesRoomName(null); setUpdatesList([])
    try {
      const rooms = await fetchRooms()
      const room = rooms.find(r => r.sessions.some(s => s.id === id))
      if (room) { setUpdatesRoomName(room.name); setUpdatesList(await fetchRoomUpdates(room.name)) }
    } catch (e: any) { setUpdatesError(e.message) }
    finally { setUpdatesLoading(false) }
  }
  createEffect(() => {
    const id = currentId()
    if (tab() === 'updates' && id) loadSessionUpdates(id)
  })

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onDragEnter={(e) => { e.preventDefault(); dragCounter++; setDragging(true) }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; setDragging(false) } }}
      onDrop={(e) => { e.preventDefault(); dragCounter = 0; setDragging(false); if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files) }}
      style={{ display: 'flex', height: 'calc(var(--vh, 1vh) * 100)', width: '100%', 'font-family': "-apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif", position: 'relative', 'overscroll-behavior': 'none' }}>

      {/* Hamburger */}
      <Show when={!sidebar()}>
        <button onClick={openSidebar} style={{ position: 'fixed', top: 'max(12px, env(safe-area-inset-top))', left: 'max(12px, env(safe-area-inset-left))', 'z-index': '50', background: '#1a1a2e', border: '1px solid #333', color: '#e5e5e5', width: '36px', height: '36px', 'border-radius': '8px', 'font-size': '18px', cursor: 'pointer', display: 'flex', 'align-items': 'center', 'justify-content': 'center', '-webkit-tap-highlight-color': 'transparent' }}>&#9776;</button>
        {/* Back to the rooms home — shown whenever a session view is open */}
        <Show when={currentId()}>
          <button onClick={goHome} style={{ position: 'fixed', top: 'max(12px, env(safe-area-inset-top))', left: 'calc(max(12px, env(safe-area-inset-left)) + 44px)', 'z-index': '50', background: '#1a1a2e', border: '1px solid #333', color: '#e5e5e5', width: '36px', height: '36px', 'border-radius': '8px', 'font-size': '20px', cursor: 'pointer', display: 'flex', 'align-items': 'center', 'justify-content': 'center', '-webkit-tap-highlight-color': 'transparent' }}>&#8249;</button>
        </Show>
      </Show>

      {/* Sidebar backdrop */}
      <Show when={sidebar()}>
        <div onClick={() => { setSidebar(false); setAgentDropdown(false) }} style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.5)', 'z-index': '59', '-webkit-tap-highlight-color': 'transparent' }} />
      </Show>

      {/* Sidebar */}
      <div style={{
        position: 'fixed', top: '0', left: '0', bottom: '0', width: '300px', 'max-width': '85vw',
        background: '#0d1117', 'z-index': '60',
        transform: sidebar() ? 'translateX(0)' : 'translateX(-100%)',
        transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        'will-change': 'transform',
        'padding-top': 'env(safe-area-inset-top)', 'padding-left': 'env(safe-area-inset-left)',
      }}>
        <div style={{ display: 'flex', 'flex-direction': 'column', height: '100%' }}>
          <div style={{ padding: '12px 16px', display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', 'border-bottom': '1px solid #1e1e1e' }}>
            <span onClick={goHome}
              style={{ 'font-weight': '700', 'font-size': '16px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Feather</span>
            <button onClick={() => setSidebar(false)} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '20px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent', padding: '4px 8px' }}>&times;</button>
          </div>
          {/* Sidebar tabs */}
          <div style={{ display: 'flex', 'border-bottom': '1px solid #1e1e1e' }}>
            <button onClick={() => setSidebarTab('sessions')} style={{ flex: '1', padding: '8px', border: 'none', 'border-bottom': sidebarTab() === 'sessions' ? '2px solid #4aba6a' : '2px solid transparent', background: 'none', color: sidebarTab() === 'sessions' ? '#e5e5e5' : '#666', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Sessions</button>
            <button onClick={() => setSidebarTab('links')} style={{ flex: '1', padding: '8px', border: 'none', 'border-bottom': sidebarTab() === 'links' ? '2px solid #4aba6a' : '2px solid transparent', background: 'none', color: sidebarTab() === 'links' ? '#e5e5e5' : '#666', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Links</button>
          </div>
          {/* Sessions tab */}
          <Show when={sidebarTab() === 'sessions'}>
            {/* Box / peer selector */}
            <Show when={boxes().length > 1}>
              <div style={{ display: 'flex', gap: '6px', padding: '10px 16px 0', 'flex-wrap': 'wrap' }}>
                <For each={[...boxes()].sort((a, b) => (a.peer === b.peer ? 0 : a.peer ? 1 : -1))}>{(b) => (
                  <button onClick={() => selectBox(b.id)} disabled={!b.available}
                    style={{
                      display: 'flex', 'align-items': 'center', gap: '5px', padding: '4px 10px',
                      background: currentBox() === b.id ? '#1a1a2e' : 'transparent',
                      border: currentBox() === b.id ? '1px solid #4aba6a' : '1px solid #2a2a2a',
                      'border-radius': '12px', color: b.available ? (currentBox() === b.id ? '#e5e5e5' : '#999') : '#444',
                      'font-size': '11px', 'font-weight': '600', cursor: b.available ? 'pointer' : 'default',
                      '-webkit-tap-highlight-color': 'transparent',
                    }}>
                    <span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: b.available ? '#4aba6a' : '#555', 'flex-shrink': '0' }} />
                    {b.peer ? `@${b.label}` : b.label}
                  </button>
                )}</For>
              </div>
            </Show>
            <Show when={!isRemoteBox()}>
            <div style={{ padding: '12px 16px', position: 'relative' }}>
              <div style={{ display: 'flex', 'border-radius': '8px', overflow: 'hidden' }}>
                <button onClick={() => handleNew('claude')} disabled={creating()} style={{ flex: '1', padding: '10px', background: creating() ? '#1a1a2e' : '#4aba6a', color: creating() ? '#666' : '#000', border: 'none', 'font-size': '14px', 'font-weight': '600', cursor: creating() ? 'wait' : 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                  {creating() ? 'Starting...' : '+ New Session'}
                </button>
                <Show when={agents().filter(a => a.available).length > 1}>
                  <button onClick={() => setAgentDropdown(!agentDropdown())} disabled={creating()} style={{ width: '36px', background: creating() ? '#1a1a2e' : agentDropdown() ? '#3a9a5a' : '#4aba6a', color: creating() ? '#666' : '#000', border: 'none', 'border-left': '1px solid rgba(0,0,0,0.15)', cursor: creating() ? 'wait' : 'pointer', 'font-size': '12px', '-webkit-tap-highlight-color': 'transparent' }}>
                    &#9662;
                  </button>
                </Show>
              </div>
              <Show when={agentDropdown()}>
                <div style={{ position: 'absolute', top: '52px', left: '16px', right: '16px', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '8px', 'z-index': '100', overflow: 'hidden' }}>
                  <For each={agents().filter(a => a.available)}>{(agent) =>
                    <button onClick={() => handleNew(agent.id)} style={{ display: 'flex', 'align-items': 'center', gap: '8px', width: '100%', padding: '10px 14px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', cursor: 'pointer', 'text-align': 'left', '-webkit-tap-highlight-color': 'transparent' }}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#252540'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                    >
                      <span style={{ width: '8px', height: '8px', 'border-radius': '50%', background: agent.id === 'omp' ? '#ff7b00' : agent.id === 'codex' ? '#c084fc' : '#4aba6a', 'flex-shrink': '0' }} />
                      <span style={{ flex: '1' }}>{agent.label}</span>
                    </button>
                  }</For>
                </div>
              </Show>
            </div>
            </Show>
            {/* Search — hits the server so it covers ALL sessions, not just the loaded 50 */}
            <div style={{ padding: '8px 16px', 'border-bottom': '1px solid #1e1e1e', position: 'relative' }}>
              <input
                value={searchQuery()}
                onInput={(e) => onSearchInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { clearSearch(); (e.target as HTMLInputElement).blur() } }}
                placeholder="Search all sessions..."
                style={{ width: '100%', background: '#141420', border: '1px solid #2a2a2a', 'border-radius': '8px', padding: '7px 28px 7px 10px', color: '#e5e5e5', 'font-size': '13px', outline: 'none', 'box-sizing': 'border-box' }}
              />
              <Show when={searchQuery()}>
                <span onClick={clearSearch}
                  style={{ position: 'absolute', right: '24px', top: '50%', transform: 'translateY(-50%)', color: '#666', cursor: 'pointer', 'font-size': '14px', padding: '2px 4px', '-webkit-tap-highlight-color': 'transparent' }}>&times;</span>
              </Show>
            </div>
            <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', 'padding-bottom': 'env(safe-area-inset-bottom)' }}>
              <Show when={searchQuery().trim() && searching() && searchResults() === null}>
                <div style={{ padding: '14px 16px', 'font-size': '12px', color: '#666' }}>Searching...</div>
              </Show>
              <Show when={searchQuery().trim() && searchResults() !== null && searchResults()!.length === 0 && !searching()}>
                <div style={{ padding: '14px 16px', 'font-size': '12px', color: '#666' }}>No sessions match "{searchQuery().trim()}"</div>
              </Show>
              {(() => {
                const isSearch = !!searchQuery().trim() && searchResults() !== null
                const source = isSearch ? searchResults()! : sessions()
                const all = source.filter(s => !s.isWorker)
                const now = new Date()
                const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
                const yesterdayStart = todayStart - 86400000
                const weekStart = todayStart - 6 * 86400000
                const groups: { label: string, items: SessionMeta[] }[] = [
                  { label: 'Today', items: [] },
                  { label: 'Yesterday', items: [] },
                  { label: 'This Week', items: [] },
                  { label: 'Older', items: [] },
                ]
                for (const s of all) {
                  const t = new Date(s.updatedAt).getTime()
                  if (t >= todayStart) groups[0].items.push(s)
                  else if (t >= yesterdayStart) groups[1].items.push(s)
                  else if (t >= weekStart) groups[2].items.push(s)
                  else groups[3].items.push(s)
                }
                return <><Show when={isSearch && all.length > 0}>
                  <div style={{ padding: '6px 16px 2px', 'font-size': '10px', 'font-weight': '600', color: '#4aba6a', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>{all.length} result{all.length === 1 ? '' : 's'}</div>
                </Show>
                <For each={groups.filter(g => g.items.length > 0)}>{(group) => <>
                  <div style={{ padding: '6px 16px 2px', 'font-size': '10px', 'font-weight': '600', color: '#555', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>{group.label}</div>
                  <For each={group.items}>{(s) => (
                    <div onClick={() => { if (sidebarRenaming() !== s.id) select(s.id) }}
                      onDblClick={(e) => { e.preventDefault(); if (!isRemoteBox()) { setSidebarRenameText(s.title); setSidebarRenaming(s.id) } }}
                      onContextMenu={(e) => { e.preventDefault(); if (!isRemoteBox()) { setSidebarRenameText(s.title); setSidebarRenaming(s.id) } }}
                      style={{ padding: '10px 16px', cursor: 'pointer', 'border-left': s.id === currentId() ? '3px solid #4aba6a' : '3px solid transparent', background: s.id === currentId() ? '#1a1a2e' : 'transparent', 'border-bottom': '1px solid #111', '-webkit-tap-highlight-color': 'transparent' }}>
                      <Show when={sidebarRenaming() === s.id} fallback={
                        <>
                        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                          <Show when={s.isActive}><span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>
                          <span style={{ 'font-size': '13px', 'font-weight': '500', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }}>{s.title}</span>
                          <Show when={s.agent === 'omp'}><span style={{ 'font-size': '9px', padding: '1px 5px', 'border-radius': '3px', background: '#3a2200', color: '#ff7b00', 'flex-shrink': '0', 'font-weight': '600' }}>omp</span></Show>
                          <Show when={s.agent === 'codex'}><span style={{ 'font-size': '9px', padding: '1px 5px', 'border-radius': '3px', background: '#2a1e3a', color: '#c084fc', 'flex-shrink': '0', 'font-weight': '600' }}>codex</span></Show>
                          <span style={{ 'font-size': '11px', color: '#555', 'flex-shrink': '0' }}>{timeAgo(s.updatedAt)}</span>
                        </div>
                        <Show when={s.projectLabel}>
                          <div style={{ 'font-size': '10px', color: '#555', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'margin-top': '2px' }}>{s.projectLabel}</div>
                        </Show>
                        </>
                      }>
                        <input
                          value={sidebarRenameText()}
                          onInput={(e) => setSidebarRenameText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleSidebarRename(s.id); if (e.key === 'Escape') setSidebarRenaming(null) }}
                          onBlur={() => handleSidebarRename(s.id)}
                          onClick={(e) => e.stopPropagation()}
                          ref={(el) => setTimeout(() => { el.focus(); el.select() }, 0)}
                          style={{ width: '100%', background: '#1a1a2e', border: '1px solid #4aba6a', 'border-radius': '4px', padding: '2px 6px', color: '#e5e5e5', 'font-size': '13px', outline: 'none' }}
                        />
                      </Show>
                      <Show when={sidecarsForSession(s.id).length > 0 || s.id === currentId()}>
                        <div style={{ 'margin-top': '6px', 'padding-left': '14px', display: 'flex', 'flex-direction': 'column', gap: '3px' }}>
                          <For each={sidecarsForSession(s.id)}>{(g) => (
                            <div onClick={(e) => { e.stopPropagation(); setOpenSidecarId(g.id) }}
                              style={{ 'font-size': '11px', color: '#9a9ab0', cursor: 'pointer', display: 'flex', 'align-items': 'center', gap: '5px', '-webkit-tap-highlight-color': 'transparent' }}
                              onMouseOver={(e) => (e.currentTarget.style.color = '#cccccc')}
                              onMouseOut={(e) => (e.currentTarget.style.color = '#9a9ab0')}>
                              <span style={{ color: '#4aba6a' }}>↳</span>
                              <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }}>{g.members.filter(m => m.spawned).map(m => m.role).join(', ')}</span>
                              <span style={{ color: '#555' }}>{g.members.length}p</span>
                            </div>
                          )}</For>
                          <Show when={s.id === currentId() && !isRemoteBox()}>
                            <div onClick={(e) => { e.stopPropagation(); spawnSidecarFor(s.id) }}
                              style={{ 'font-size': '11px', color: '#555', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}
                              onMouseOver={(e) => (e.currentTarget.style.color = '#6aa6e5')}
                              onMouseOut={(e) => (e.currentTarget.style.color = '#555')}>+ sidecar</div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )}</For>
                </>}</For></>
              })()}
            </div>
          </Show>
          {/* Links tab */}
          <Show when={sidebarTab() === 'links'}>
            <div style={{ flex: '1', 'overflow-y': 'auto', padding: '8px 0', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', 'padding-bottom': 'env(safe-area-inset-bottom)' }}>
              <For each={links()}>{(link) => (
                <a href={link.url} target="_blank" rel="noopener" style={{ display: 'block', padding: '10px 16px', color: '#73b8ff', 'text-decoration': 'none', 'font-size': '13px', 'font-weight': '500', 'border-bottom': '1px solid #111', '-webkit-tap-highlight-color': 'transparent' }}
                  onMouseOver={(e) => (e.currentTarget.style.background = '#1a1a2e')}
                  onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}>
                  {link.label}
                  <span style={{ color: '#444', 'font-size': '11px', 'margin-left': '8px' }}>{link.url}</span>
                </a>
              )}</For>
              <Show when={links().length === 0}>
                <div style={{ padding: '20px 16px', color: '#555', 'font-size': '13px' }}>No quick links yet. Use /feather add link to add some.</div>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      {/* Sidecar thread overlay (opened from a session's nested list) */}
      <Show when={openSidecarId()}>
        <div style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.55)', 'z-index': '200', display: 'flex', 'justify-content': 'flex-end' }}
          onClick={() => setOpenSidecarId(null)}>
          <div style={{ width: 'min(460px, 100%)', height: '100%', background: '#0d0d12', 'border-left': '1px solid #222' }}
            onClick={(e) => e.stopPropagation()}>
            <SidecarThread id={openSidecarId} onClose={() => setOpenSidecarId(null)} onOpenSession={(id) => { setOpenSidecarId(null); select(id) }} onChange={refreshSidecars} />
          </div>
        </div>
      </Show>

      {/* Main */}
      <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-width': '0', height: '100%' }}>
        {/* Header */}
        <div style={{ padding: '8px 16px 0 100px', 'padding-top': 'max(8px, env(safe-area-inset-top))', 'border-bottom': '1px solid #1e1e1e', display: 'flex', 'align-items': 'center', gap: '8px', 'min-height': '48px', 'flex-shrink': '0' }}>
          <Show when={cur()} fallback={<span style={{ color: '#666', 'font-size': '14px' }}>Select a session</span>}>
            {(s) => <>
              <Show when={s().isActive}><span style={{ width: '8px', height: '8px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>
              <Show when={renaming()} fallback={
                <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'font-size': '14px', 'font-weight': '600' }}>{s().title}</span>
              }>
                <input
                  value={renameText()}
                  onInput={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleRename(s().id); if (e.key === 'Escape') setRenaming(false) }}
                  onBlur={() => handleRename(s().id)}
                  ref={(el) => setTimeout(() => el.focus(), 0)}
                  style={{ background: '#1a1a2e', border: '1px solid #4aba6a', 'border-radius': '6px', padding: '2px 8px', color: '#e5e5e5', 'font-size': '14px', 'font-weight': '600', outline: 'none', flex: '1', 'min-width': '0' }}
                />
              </Show>
              <div style={{ flex: '1' }} />
              <Show when={isPeerBox()}>
                <span style={{ 'font-size': '11px', color: '#888', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '10px', padding: '2px 8px', 'flex-shrink': '0' }}>
                  @{boxes().find(b => b.id === currentBox())?.label || currentBox()}{peerControl() ? '' : ' \u00B7 view only'}
                </span>
              </Show>
              <Show when={s().isActive && canSend()}>
                <button onClick={() => handleInterrupt(s().id)} style={{ background: '#d45555', color: '#fff', border: 'none', 'border-radius': '6px', padding: '4px 12px', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Stop</button>
              </Show>
              <Show when={!s().isActive && !isRemoteBox()}>
                <button onClick={() => handleResume(s().id)} style={{ background: '#4aba6a', color: '#000', border: 'none', 'border-radius': '6px', padding: '4px 12px', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Resume</button>
              </Show>
              <div style={{ position: 'relative' }}>
                <button onClick={() => setMenuOpen(!menuOpen())} style={{ background: 'none', border: 'none', color: '#888', 'font-size': '18px', cursor: 'pointer', padding: '4px 6px', '-webkit-tap-highlight-color': 'transparent' }}>{'\u22EE'}</button>
                <Show when={menuOpen()}>
                  <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: '0', 'z-index': '99' }} />
                  <div style={{ position: 'absolute', right: '0', top: '100%', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '8px', 'box-shadow': '0 4px 12px rgba(0,0,0,0.5)', 'z-index': '100', 'min-width': '140px', overflow: 'hidden' }}>
                    <Show when={!isRemoteBox()}>
                      <button onClick={() => { setRenameText(s().title); setRenaming(true); setMenuOpen(false) }}
                        style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Rename</button>
                    </Show>
                    <Show when={!isRemoteBox() && sharingPeers().length > 0}>
                      <button onClick={() => handleShare(s().id)}
                        style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>
                        Share\u2026{s().share?.length ? ` (${s().share!.join(', ')})` : ''}
                      </button>
                    </Show>
                    <a href={exportUrl(s().id, currentBox())} download="" style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer', 'text-decoration': 'none' }} onClick={() => setMenuOpen(false)}>Export MD</a>
                    <Show when={!isRemoteBox()}>
                      <button onClick={() => handleDelete(s().id)}
                        style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', color: '#d45555', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Delete</button>
                    </Show>
                  </div>
                </Show>
              </div>
            </>}
          </Show>
        </div>

        {/* Tabs */}
        <Show when={currentId()}>
          <div style={{ display: 'flex', 'align-items': 'center', 'border-bottom': '1px solid #1e1e1e', 'padding-left': '16px', 'flex-shrink': '0' }}>
            <button onClick={() => setTab('chat')} style={tabStyle('chat')}>Chat</button>
            <button onClick={() => setTab('prompts')} style={tabStyle('prompts')}>Prompts</button>
            <Show when={!isRemoteBox()}>
              <button onClick={() => setTab('updates')} style={tabStyle('updates')}>Updates</button>
              <button onClick={() => setTab('files')} style={tabStyle('files')}>Files{touchedFiles().length > 0 ? ` (${touchedFiles().length})` : ''}</button>
              <button onClick={() => setTab('terminal')} style={tabStyle('terminal')}>Terminal</button>
            </Show>
            <span style={{ 'margin-left': 'auto', 'padding-right': '12px', 'font-size': '10px', color: '#333' }}>{__BUILD_TIME__}</span>
          </div>
        </Show>

        {/* Reconnecting banner */}
        <Show when={sseStatus() === 'reconnecting' && currentId()}>
          <div style={{ padding: '4px 16px', background: '#c4993a', color: '#000', 'font-size': '12px', 'font-weight': '600', 'text-align': 'center', 'flex-shrink': '0' }}>Reconnecting...</div>
        </Show>

        {/* Content */}
        <div style={{ flex: '1', overflow: 'hidden', display: expanded() ? 'none' : 'block' }}>
          <Show when={currentId()} fallback={
            <RoomsHome onOpen={select} onSessionsChanged={refreshSessions} />
          }>
            <div style={{ display: tab() === 'chat' ? 'block' : 'none', height: '100%' }}>
              <MessageView messages={messages()} loading={loading()} hasMore={hasMore()} loadingMore={loadingMore()} onLoadEarlier={loadEarlier} onAnswer={(t) => { if (currentId() && canSend()) sendInput(currentId()!, t, currentBox()) }} starred={new Set(starred()[currentId()!] || [])} onToggleStar={(uuid) => { if (currentId()) toggleStar(currentId()!, uuid) }} working={working()} />
            </div>
            <div style={{ display: tab() === 'files' ? 'flex' : 'none', 'flex-direction': 'column', height: '100%', overflow: 'hidden' }}>
              {/* Mode toggle */}
              <div style={{ display: 'flex', gap: '4px', padding: '8px 12px', 'border-bottom': '1px solid #1e1e1e', 'flex-shrink': '0' }}>
                <button onClick={() => setFilesMode('changed')}
                  style={{ background: filesMode() === 'changed' ? '#1e1e1e' : 'transparent', border: '1px solid #333', color: filesMode() === 'changed' ? '#e5e5e5' : '#888', 'font-size': '12px', padding: '4px 10px', 'border-radius': '6px', cursor: 'pointer' }}>
                  Changed{touchedFiles().length > 0 ? ` (${touchedFiles().length})` : ''}
                </button>
                <button onClick={() => setFilesMode('all')}
                  style={{ background: filesMode() === 'all' ? '#1e1e1e' : 'transparent', border: '1px solid #333', color: filesMode() === 'all' ? '#e5e5e5' : '#888', 'font-size': '12px', padding: '4px 10px', 'border-radius': '6px', cursor: 'pointer' }}>
                  All files
                </button>
              </div>
              {/* Changed files view */}
              <Show when={filesMode() === 'changed'}>
                <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', padding: '8px 0' }}>
                  <Show when={touchedFiles().length === 0}>
                    <div style={{ color: '#555', 'text-align': 'center', padding: '40px', 'font-size': '13px' }}>No files touched yet</div>
                  </Show>
                  <For each={touchedFiles()}>{(f) => {
                    const short = f.path.split('/').slice(-2).join('/')
                    const actionColors: Record<string, string> = { Read: '#73b8ff', Write: '#4aba6a', Edit: '#c4993a', Grep: '#b48ead', Glob: '#88c0d0' }
                    return (
                      <div onClick={() => openFile(f.path)} style={{ padding: '8px 16px', 'border-bottom': '1px solid #111', 'font-size': '13px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                        <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                          <span style={{ color: '#e5e5e5', 'font-family': "'SF Mono', Menlo, monospace", overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }} title={f.path}>{short}</span>
                          <For each={f.actions}>{(a) => (
                            <span style={{ 'font-size': '10px', padding: '1px 5px', 'border-radius': '3px', background: 'rgba(255,255,255,0.05)', color: actionColors[a] || '#888' }}>{a}</span>
                          )}</For>
                        </div>
                        <div style={{ color: '#444', 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", 'margin-top': '2px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{f.path}</div>
                      </div>
                    )
                  }}</For>
                </div>
              </Show>
              {/* All files view */}
              <Show when={filesMode() === 'all'}>
                <Show when={browse()}>
                  <div style={{ padding: '8px 16px', 'border-bottom': '1px solid #1e1e1e', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace", 'flex-shrink': '0', display: 'flex', 'align-items': 'center', gap: '8px' }}>
                    <div style={{ flex: '1', 'overflow-x': 'auto', 'white-space': 'nowrap' }}>
                      {(() => {
                        const p = browse()!.path
                        const parts = p === '/' ? [''] : p.split('/')
                        return <For each={parts}>{(part, i) => {
                          const isLast = i() === parts.length - 1
                          const segment = parts.slice(0, i() + 1).join('/') || '/'
                          return <>
                            <span onClick={() => !isLast && loadBrowse(segment)}
                              style={{ color: isLast ? '#e5e5e5' : '#73b8ff', cursor: isLast ? 'default' : 'pointer' }}>
                              {i() === 0 ? '/' : part}
                            </span>
                            {i() > 0 && !isLast && <span style={{ color: '#444' }}>/</span>}
                          </>
                        }}</For>
                      })()}
                    </div>
                    <div style={{ display: 'flex', gap: '4px', 'flex-shrink': '0' }}>
                      <button onClick={() => setSort('name')}
                        title="Sort by name"
                        style={{ background: browseSort() === 'name' ? '#1e1e1e' : 'transparent', border: '1px solid #333', color: browseSort() === 'name' ? '#e5e5e5' : '#888', 'font-size': '11px', padding: '2px 8px', 'border-radius': '4px', cursor: 'pointer' }}>Name</button>
                      <button onClick={() => setSort('mtime')}
                        title="Sort by recently modified"
                        style={{ background: browseSort() === 'mtime' ? '#1e1e1e' : 'transparent', border: '1px solid #333', color: browseSort() === 'mtime' ? '#e5e5e5' : '#888', 'font-size': '11px', padding: '2px 8px', 'border-radius': '4px', cursor: 'pointer' }}>Recent</button>
                    </div>
                  </div>
                </Show>
                <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch' }}>
                  <Show when={browseLoading() && !browse()}>
                    <div style={{ color: '#555', 'text-align': 'center', padding: '40px', 'font-size': '13px' }}>Loading…</div>
                  </Show>
                  <Show when={browse()}>
                    <Show when={browse()!.parent !== null}>
                      <div onClick={() => loadBrowse(browse()!.parent!)}
                        style={{ padding: '8px 16px', 'border-bottom': '1px solid #111', 'font-size': '13px', color: '#888', cursor: 'pointer', 'font-family': "'SF Mono', Menlo, monospace" }}>
                        ../
                      </div>
                    </Show>
                    <For each={sortedBrowseEntries()}>{(e) => {
                      const full = browse()!.path === '/' ? '/' + e.name : browse()!.path + '/' + e.name
                      const isDir = e.type === 'dir'
                      const delBtn = (
                        <button onClick={(ev) => { ev.stopPropagation(); deleteBrowseEntry(full, e.name, isDir) }}
                          title={`Delete ${e.name}`}
                          class="browse-del-btn"
                          style={{ background: 'transparent', border: '1px solid #333', color: '#888', 'font-size': '11px', padding: '2px 6px', 'border-radius': '4px', cursor: 'pointer', 'flex-shrink': '0' }}>
                          ✕
                        </button>
                      )
                      return isDir ? (
                        <div onClick={() => loadBrowse(full)}
                          class="browse-row"
                          style={{ padding: '8px 16px', 'border-bottom': '1px solid #111', 'font-size': '13px', cursor: 'pointer', display: 'flex', 'align-items': 'center', gap: '8px', 'font-family': "'SF Mono', Menlo, monospace" }}>
                          <span style={{ color: '#73b8ff', flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{e.name}/</span>
                          {browseSort() === 'mtime' && e.mtime > 0 && <span style={{ color: '#444', 'font-size': '11px' }}>{formatRelTime(e.mtime)}</span>}
                          {delBtn}
                        </div>
                      ) : (
                        <div onClick={() => openFile(full)}
                          class="browse-row"
                          style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '8px 16px', 'border-bottom': '1px solid #111', 'font-size': '13px', color: '#e5e5e5', cursor: 'pointer', 'font-family': "'SF Mono', Menlo, monospace" }}>
                          <span style={{ flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{e.name}</span>
                          <span style={{ color: '#444', 'font-size': '11px' }}>{browseSort() === 'mtime' && e.mtime > 0 ? formatRelTime(e.mtime) : formatSize(e.size)}</span>
                          {delBtn}
                        </div>
                      )
                    }}</For>
                    <Show when={browse()!.entries.length === 0}>
                      <div style={{ color: '#555', 'text-align': 'center', padding: '40px', 'font-size': '13px' }}>Empty</div>
                    </Show>
                  </Show>
                </div>
              </Show>
            </div>
            <div style={{ display: tab() === 'terminal' ? 'block' : 'none', height: '100%' }}>
              <Show when={tab() === 'terminal'}>
                <Suspense fallback={<div style={{ padding: '12px', color: '#888' }}>Loading terminal…</div>}>
                  <Terminal sessionId={currentId()} />
                </Suspense>
              </Show>
            </div>
            <div data-testid="prompts-panel" style={{ display: tab() === 'prompts' ? 'flex' : 'none', 'flex-direction': 'column', height: '100%', overflow: 'hidden' }}>
              <div ref={promptsScroller} style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', padding: '12px 16px 24px' }}>
                <For each={userPrompts()} fallback={<div style={{ color: '#666', 'font-size': '13px', padding: '16px 4px' }}>No prompts yet in this chat.</div>}>
                  {(m) => (
                    <div style={{ 'margin-bottom': '10px', padding: '10px 12px', background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '10px' }}>
                      <div style={{ 'font-size': '10px', color: '#5a6472', 'font-family': 'monospace', 'margin-bottom': '4px' }}>{fmtFeedTime(m.timestamp)}</div>
                      <div style={{ 'font-size': '14px', color: '#e0e3e8', 'line-height': '1.5', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{promptText(m)}</div>
                    </div>
                  )}
                </For>
              </div>
            </div>
            <div data-testid="updates-panel" style={{ display: tab() === 'updates' ? 'flex' : 'none', 'flex-direction': 'column', height: '100%', overflow: 'hidden' }}>
              <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', padding: '12px 16px 24px' }}>
                <Show when={updatesError()}>
                  <div style={{ color: '#d45555', 'font-size': '13px', padding: '8px 4px' }}>{updatesError()}</div>
                </Show>
                <Show when={updatesLoading()}>
                  <div style={{ color: '#666', 'font-size': '13px', padding: '8px 4px' }}>Loading updates…</div>
                </Show>
                <Show when={!updatesLoading() && !updatesError() && !updatesRoomName()}>
                  <div style={{ color: '#666', 'font-size': '13px', padding: '8px 4px', 'line-height': '1.5' }}>This chat isn't in a Room, so it has no Updates feed. Updates live per Room — open the Rooms home screen to see them.</div>
                </Show>
                <Show when={updatesRoomName()}>
                  <div style={{ 'font-size': '12px', color: '#7a8290', 'margin-bottom': '10px' }}>Updates for <span style={{ color: '#9aa4b2', 'font-weight': '600' }}>#{updatesRoomName()}</span></div>
                  <For each={[...updatesList()].reverse()} fallback={<div style={{ color: '#666', 'font-size': '13px', padding: '4px' }}>No updates yet in this Room.</div>}>
                    {(u) => (
                      <div style={{ padding: '9px 0', 'border-bottom': '1px solid #14141c' }}>
                        <div style={{ 'font-size': '10px', color: '#5a6472', 'font-family': 'monospace', 'margin-bottom': '3px' }}>{fmtFeedTime(u.ts)}</div>
                        <div style={{ 'font-size': '13px', color: '#d0d4da', 'line-height': '1.5', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{u.text}</div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </Show>
        </div>

        {/* File viewer modal */}
        <Show when={viewingFile()}>
          {(() => {
            const v = viewingFile()!
            const fileUrl = localFileUrl(v.path)!
            return (
              <div onClick={() => setViewingFile(null)} style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.6)', 'z-index': '200', display: 'flex', 'align-items': 'stretch', 'justify-content': 'center', padding: 'max(20px, env(safe-area-inset-top)) 16px max(20px, env(safe-area-inset-bottom))' }}>
                <div onClick={(e) => e.stopPropagation()} style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '12px', 'max-width': '900px', width: '100%', display: 'flex', 'flex-direction': 'column', 'overflow': 'hidden' }}>
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '10px 14px', 'border-bottom': '1px solid #1e1e1e', background: '#0a0e14', 'flex-shrink': '0' }}>
                    <span style={{ color: '#888', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace", overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }} title={v.path}>{v.path}</span>
                    <a href={fileUrl} target="_blank" rel="noopener" style={{ background: 'transparent', border: '1px solid #333', color: '#888', 'font-size': '11px', padding: '3px 8px', 'border-radius': '6px', cursor: 'pointer', 'text-decoration': 'none' }}>Open</a>
                    <button onClick={() => setViewingFile(null)} style={{ background: 'transparent', border: 'none', color: '#888', 'font-size': '20px', cursor: 'pointer', padding: '0 4px', 'line-height': '1' }}>&times;</button>
                  </div>
                  <div style={{ 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', flex: '1', display: 'flex', 'flex-direction': 'column' }}>
                    <Show when={v.error}>
                      <div style={{ padding: '20px', color: '#c44', 'font-size': '13px' }}>{v.error}</div>
                    </Show>
                    <Show when={v.kind === 'image'}>
                      <div style={{ padding: '12px', display: 'flex', 'align-items': 'center', 'justify-content': 'center', flex: '1', background: '#000' }}>
                        <img src={fileUrl} style={{ 'max-width': '100%', 'max-height': '80vh', 'object-fit': 'contain' }} />
                      </div>
                    </Show>
                    <Show when={v.kind === 'pdf'}>
                      <iframe src={fileUrl} style={{ width: '100%', height: '80vh', border: 'none', background: '#fff' }} />
                    </Show>
                    <Show when={v.kind === 'md' && !v.error && v.content}>
                      <div class="prose" style={{ padding: '4px 24px', color: '#d0d0d0', 'font-size': '14px', 'line-height': '1.55' }} innerHTML={marked.parse(v.content) as string} />
                    </Show>
                    <Show when={v.kind === 'text' && !v.error && v.content}>
                      <pre style={{ margin: '0', padding: '16px 20px', color: '#d0d0d0', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace", 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{v.content}</pre>
                    </Show>
                    <Show when={!v.error && !v.content && (v.kind === 'md' || v.kind === 'text')}>
                      <div style={{ padding: '20px', color: '#666', 'font-size': '13px' }}>Loading…</div>
                    </Show>
                  </div>
                </div>
              </div>
            )
          })()}
        </Show>

        {/* Drag overlay */}
        <Show when={dragging()}>
          <div style={{ position: 'absolute', inset: '0', background: 'rgba(74,186,106,0.1)', border: '2px dashed #4aba6a', 'border-radius': '12px', 'z-index': '100', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'pointer-events': 'none' }}>
            <span style={{ color: '#4aba6a', 'font-size': '18px', 'font-weight': '600' }}>Drop files to attach</span>
          </div>
        </Show>

        {/* View-only notice (peer session without control) */}
        <Show when={currentId() && tab() === 'chat' && !canSend()}>
          <div style={{ padding: '10px 16px', 'border-top': '1px solid #1e1e1e', background: '#0a0e14', color: '#666', 'font-size': '12px', 'text-align': 'center', 'padding-bottom': 'max(10px, env(safe-area-inset-bottom))' }}>
            View only — {boxes().find(b => b.id === currentBox())?.label || 'this peer'} hasn't granted you send access
          </div>
        </Show>

        {/* Input (chat tab only) */}
        <Show when={currentId() && tab() === 'chat' && canSend()}>
          <input ref={fileInputRef} type="file" multiple hidden title="Maximum file size: 50 MB" onChange={(e) => { if (e.target.files?.length) { addFiles(e.target.files); e.target.value = '' } }} />
          <Show when={mediaNotice()}>
            <div role="status" style={{ padding: '7px 12px', 'border-top': '1px solid #332b18', background: '#17140b', color: '#d8bd66', 'font-size': '12px', display: 'flex', 'justify-content': 'space-between', gap: '8px' }}>
              <span>{mediaNotice()}</span><button onClick={dismissMediaNotice} style={{ background: 'none', border: 'none', color: '#d8bd66', cursor: 'pointer' }}>&times;</button>
            </div>
          </Show>
          {/* File previews */}
          <Show when={files().length > 0}>
            <div style={{ padding: '6px 12px 0', 'border-top': '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
              <For each={files()}>{(f, i) => (
                <div style={{ position: 'relative', background: '#1a1a2e', 'border-radius': '8px', padding: '4px', border: '1px solid #333' }}>
                  {f.isImage
                    ? <img src={f.dataUrl} style={{ height: '56px', 'max-width': '100px', 'border-radius': '6px', 'object-fit': 'cover', display: 'block' }} />
                    : <div style={{ padding: '4px 8px', 'font-size': '11px', color: '#999', 'max-width': '100px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{f.name}</div>
                  }
                  <Show when={f.status !== 'draft'}>
                    <div style={{ 'font-size': '10px', color: f.status === 'failed' ? '#ff7b72' : '#8b949e', 'max-width': '120px', padding: '3px 4px' }}>
                      {fileStatusLabel(f)}
                    </div>
                  </Show>
                  <Show when={f.status === 'failed'}>
                    <div style={{ display: 'flex', gap: '4px', padding: '2px' }}>
                      <button onClick={() => uploadPendingFile(f).catch(() => {})} disabled={uploading()} style={{ 'font-size': '10px' }}>Retry</button>
                      <button onClick={() => downloadBlob(f.blob, f.name)} style={{ 'font-size': '10px' }}>Download</button>
                    </div>
                  </Show>
                  <button onClick={() => removeFile(i())} disabled={uploading()} aria-label={`Remove ${f.name}`} style={{ position: 'absolute', top: '-6px', right: '-6px', width: '22px', height: '22px', 'border-radius': '50%', background: '#d45555', color: '#fff', border: 'none', 'font-size': '12px', cursor: uploading() ? 'wait' : 'pointer', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'line-height': '1' }}>&times;</button>
                </div>
              )}</For>
            </div>
          </Show>
          <Show when={voiceMemos().length > 0}>
            <div style={{ padding: '6px 12px', 'border-top': '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
              <For each={voiceMemos()}>{(memo) => (
                <div style={{ background: '#1a1a2e', border: `1px solid ${memo.status === 'failed' ? '#6e3636' : '#333'}`, 'border-radius': '8px', padding: '7px 9px', 'font-size': '11px', color: '#bbb', 'max-width': '280px' }}>
                  <div>🎤 {voiceStatusLabel(memo)}</div>
                  <Show when={memo.status === 'failed'}>
                    <div style={{ display: 'flex', gap: '5px', 'margin-top': '5px' }}>
                      <Show when={isRetryableVoiceMemo(memo)}><button onClick={() => processVoiceMemo(memo)} disabled={transcribing()} style={{ 'font-size': '10px' }}>Retry</button></Show>
                      <button onClick={() => downloadBlob(memo.blob, memo.name)} style={{ 'font-size': '10px' }}>Download</button>
                      <button onClick={() => removeVoiceMemo(memo.id)} style={{ 'font-size': '10px' }}>Remove</button>
                    </div>
                  </Show>
                </div>
              )}</For>
            </div>
          </Show>
          <Show when={showMotionChart()}>
            <div style={{ height: '42px', width: '100%', background: '#05070b', 'border-top': '1px solid #1e1e1e', position: 'relative', overflow: 'hidden', 'flex-shrink': '0' }}>
              <svg viewBox="0 0 100 32" preserveAspectRatio="none" style={{ position: 'absolute', inset: '0', width: '100%', height: '100%', 'pointer-events': 'none' }} aria-hidden="true">
                <line x1="0" y1="10.5" x2="100" y2="10.5" stroke="rgba(255,255,255,0.06)" stroke-width="0.35" />
                <line x1="0" y1="21.5" x2="100" y2="21.5" stroke="rgba(255,255,255,0.06)" stroke-width="0.35" />
                <polyline points={motionChartPoints('peakDps', 900)} fill="none" stroke="#4aba6a" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
                <polyline points={motionChartPoints('degrees', 900)} fill="none" stroke="#c9a227" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
              </svg>
              <div style={{ position: 'absolute', left: '10px', top: '5px', display: 'flex', gap: '10px', 'font-size': '10px', 'font-weight': '700', 'font-family': "'SF Mono', Menlo, monospace", 'pointer-events': 'none' }}>
                <span style={{ color: '#4aba6a' }}>p {motionPeakDps()}</span>
                <span style={{ color: '#c9a227' }}>d {motionDegrees()}</span>
              </div>
              <Show when={tossCalibration()}>
                <div style={{ position: 'absolute', left: '10px', bottom: '4px', color: '#d0d0d0', 'font-size': '10px', 'font-weight': '700', 'font-family': "'SF Mono', Menlo, monospace", 'pointer-events': 'none' }}>{tossCalibrationSummary()}</div>
              </Show>
              <button onClick={toggleTossCalibration} title={tossCalibration() ? 'Turn off toss calibration' : 'Calibrate toss'} aria-pressed={tossCalibration()} style={{ position: 'absolute', right: '10px', top: '7px', height: '26px', padding: '0 9px', background: tossCalibration() ? '#c9a227' : 'rgba(255,255,255,0.06)', border: tossCalibration() ? '1px solid #c9a227' : '1px solid #333', 'border-radius': '6px', color: tossCalibration() ? '#05070b' : '#d0d0d0', 'font-size': '11px', 'font-weight': '800', 'font-family': 'inherit', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent', 'z-index': '1' }}>Cal</button>
            </div>
          </Show>
          <div style={{ padding: expanded() ? '0' : '8px 12px', 'padding-bottom': expanded() ? '0' : 'max(8px, env(safe-area-inset-bottom))', 'border-top': files().length ? 'none' : '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', 'flex-direction': expanded() ? 'column' : 'row', gap: expanded() ? '0' : '8px', 'align-items': expanded() ? 'stretch' : 'flex-end', 'flex-shrink': '0', 'flex-grow': expanded() ? '1' : '0', position: 'relative', ...(expanded() ? { 'min-height': '0' } : {}) }}>
            <Show when={historyOpen()}>
              <div onClick={() => setHistoryOpen(false)} style={{ position: 'fixed', inset: '0', 'z-index': '49' }} />
              <div style={{ position: 'absolute', bottom: '100%', left: '0', right: '0', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '8px 8px 0 0', 'max-height': '200px', 'overflow-y': 'auto', 'z-index': '50' }}>
                <For each={getHistory().slice().reverse()}>{(item) => (
                  <button onClick={() => { setText(item); setHistoryOpen(false) }}
                    style={{ display: 'block', width: '100%', padding: '8px 12px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#ccc', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{item}</button>
                )}</For>
              </div>
            </Show>
            <Show when={!expanded()}>
              <button onClick={() => fileInputRef?.click()} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '20px', cursor: 'pointer', padding: '8px 4px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '32px', 'min-height': '42px' }} title="Attach file (max 50 MB)">+</button>
              <button onClick={() => setHistoryOpen(!historyOpen())} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '16px', cursor: 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px' }} title="Message history">{'\u2191'}</button>
              <button onClick={toggleVoice} disabled={transcribing()} style={{ background: listening() ? `rgba(212, 85, 85, ${0.15 + audioLevel() * 0.35})` : 'none', border: listening() ? '1px solid #d45555' : 'none', 'border-radius': '8px', color: transcribing() ? '#c9a227' : listening() ? '#d45555' : '#666', 'font-size': '16px', cursor: transcribing() ? 'wait' : 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px', transition: 'all 0.15s' }} title={voiceTitle()} aria-label={voiceTitle()}>{transcribing() ? '\u23F3' : listening() ? '\u23F9' : '\uD83C\uDF99'}</button>
              <button onClick={() => { setExpanded(true); setTimeout(() => { if (textareaRef) { textareaRef.style.height = 'auto'; textareaRef.focus() } }, 10) }} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '14px', cursor: 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px' }} title="Expand editor">{'\u2922'}</button>
            </Show>
            <textarea ref={textareaRef} value={text()}
              onInput={(e) => { setText(e.target.value); if (currentId()) saveDraft(currentId()!, e.target.value); if (!expanded()) { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px' } }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); setExpanded(false) }
                if (e.key === 'Escape') { setExpanded(false) }
                if (e.key === 'ArrowUp' && textareaRef?.selectionStart === 0) {
                  const h = getHistory(); if (h.length === 0) return
                  const idx = historyIdx() === -1 ? h.length - 1 : Math.max(0, historyIdx() - 1)
                  setHistoryIdx(idx); setText(h[idx]); e.preventDefault()
                }
                if (e.key === 'ArrowDown' && historyIdx() >= 0) {
                  const h = getHistory(); const idx = historyIdx() + 1
                  if (idx >= h.length) { setHistoryIdx(-1); setText(loadDraft(currentId()!) || '') }
                  else { setHistoryIdx(idx); setText(h[idx]) }
                  e.preventDefault()
                }
              }}
              onPaste={(e) => { const items = e.clipboardData?.items; if (!items) return; const imgs = [...items].filter(i => i.type.startsWith('image/')); if (imgs.length) { e.preventDefault(); addFiles(imgs.map(i => new File([i.getAsFile()!], 'pasted-image.png', { type: i.type }))) } }}
              enterkeyhint="send"
              placeholder={recordingPlaceholder()} rows={expanded() ? undefined : 1}
              style={{ flex: expanded() ? '1' : undefined, width: expanded() ? '100%' : undefined, 'flex-grow': expanded() ? '1' : undefined, background: '#1a1a2e', border: expanded() ? 'none' : '1px solid #333', 'border-radius': expanded() ? '0' : '12px', padding: expanded() ? '14px 16px' : '10px 14px', color: '#e5e5e5', 'font-size': expanded() ? '18px' : '16px', 'font-family': 'inherit', resize: 'none', outline: 'none', 'line-height': '1.5', 'max-height': expanded() ? 'none' : '120px', '-webkit-appearance': 'none', ...(listening() ? { '::placeholder': { color: '#73b8ff' } } : {}), ...(expanded() ? { 'min-height': '0', 'overflow-y': 'auto' } : { flex: '1' }) }} />
            <div style={{ display: 'flex', gap: '8px', 'align-items': 'center', padding: expanded() ? '8px 12px' : '0', 'padding-bottom': expanded() ? 'max(8px, env(safe-area-inset-bottom))' : '0', background: expanded() ? '#0a0e14' : 'transparent', 'border-top': expanded() ? '1px solid #1e1e1e' : 'none', 'justify-content': expanded() ? 'space-between' : 'flex-start' }}>
              <Show when={expanded()}>
                <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                  <button onClick={() => fileInputRef?.click()} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '20px', cursor: 'pointer', padding: '8px 4px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '32px', 'min-height': '42px' }} title="Attach file (max 50 MB)">+</button>
                  <button onClick={() => setHistoryOpen(!historyOpen())} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '16px', cursor: 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px' }} title="Message history">{'\u2191'}</button>
                  <button onClick={toggleVoice} disabled={transcribing()} style={{ background: listening() ? `rgba(212, 85, 85, ${0.15 + audioLevel() * 0.35})` : 'none', border: listening() ? '1px solid #d45555' : 'none', 'border-radius': '8px', color: transcribing() ? '#c9a227' : listening() ? '#d45555' : '#666', 'font-size': '16px', cursor: transcribing() ? 'wait' : 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px', transition: 'all 0.15s' }} title={voiceTitle()} aria-label={voiceTitle()}>{transcribing() ? '\u23F3' : listening() ? '\u23F9' : '\uD83C\uDF99'}</button>
                  <button onClick={() => { setExpanded(false); setTimeout(() => { if (textareaRef) { textareaRef.style.height = 'auto'; textareaRef.style.height = Math.min(textareaRef.scrollHeight, 120) + 'px' } }, 10) }} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '14px', cursor: 'pointer', padding: '8px 6px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-height': '42px' }} title="Collapse">{'\u2193'} Collapse</button>
                </div>
              </Show>
              <button onClick={() => { handleSend(); setExpanded(false) }} disabled={uploading() || transcribing()} title={listening() ? 'Stop, transcribe & send' : 'Send'} style={{ background: (text().trim() || files().length || listening()) ? '#4aba6a' : '#333', color: (text().trim() || files().length || listening()) ? '#000' : '#666', border: 'none', 'border-radius': '12px', padding: '10px 16px', 'font-size': '15px', 'font-weight': '600', cursor: (text().trim() || files().length || listening()) ? 'pointer' : 'default', 'min-height': '42px', '-webkit-tap-highlight-color': 'transparent' }}>{uploading() || transcribing() ? '...' : 'Send'}</button>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
