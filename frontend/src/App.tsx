declare const __BUILD_TIME__: string
import { createSignal, createEffect, onMount, onCleanup, Show, For, lazy, Suspense } from 'solid-js'
import { marked } from 'marked'
import { MessageView } from './components/MessageView'
const Terminal = lazy(() => import('./components/Terminal').then(m => ({ default: m.Terminal })))
import type { SessionMeta, Message, AgentInfo, FileListing, Project } from './api'
import { fetchSessions, fetchMessages, subscribeMessages, sendInput, createSession, resumeSession, interruptSession, uploadFile, deleteSession, renameSession, fetchStarred, saveStarred, exportUrl, fetchAgents, fetchFiles, fetchProjects, deletePath, fetchBoxes, fetchSharingPeers, setSessionShare, BASE } from './api'
import type { BoxInfo, PeerInfo } from './api'
import { createSpinGestureDetector, motionEventToSpinSample } from './spinGesture'

interface QuickLink { label: string; url: string }

interface PendingFile { name: string; blob: Blob; dataUrl: string; isImage: boolean }

type SpinGestureState = 'off' | 'requesting' | 'calibrating' | 'ready' | 'triggered' | 'denied' | 'unsupported'
type DeviceMotionPermissionApi = typeof DeviceMotionEvent & { requestPermission?: () => Promise<PermissionState> }
type DeviceOrientationPermissionApi = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<PermissionState> }
type MotionChartPoint = { peakDps: number; degrees: number }
type TossCalibrationStats = { maxPeakDps: number; maxDegrees: number; hits: number }

const MAX_MOTION_CHART_POINTS = 120

function resizeImage(blob: Blob, maxDim = 1600): Promise<Blob> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const { width: w, height: h } = img
      if (w <= maxDim && h <= maxDim) { resolve(blob); return }
      const scale = Math.min(maxDim / w, maxDim / h)
      const c = document.createElement('canvas')
      c.width = w * scale; c.height = h * scale
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
      c.toBlob(b => resolve(b || blob), 'image/png')
    }
    img.src = URL.createObjectURL(blob)
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
  const [tab, setTab] = createSignal<'chat' | 'files' | 'terminal'>('chat')
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
      const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent(path)}`)
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
  const [sidebarTab, setSidebarTab] = createSignal<'sessions' | 'links' | 'auto' | 'cos'>('sessions')
  const [projects, setProjects] = createSignal<Project[]>([])
  const [currentProject, setCurrentProject] = createSignal<string | null>(localStorage.getItem('feather-project'))
  const [projectsExpanded, setProjectsExpanded] = createSignal(false)
  const [expandedGroups, setExpandedGroups] = createSignal<Record<string, boolean>>(JSON.parse(localStorage.getItem('feather-project-groups') || '{}'))
  function toggleGroup(g: string) {
    const next = { ...expandedGroups(), [g]: !expandedGroups()[g] }
    setExpandedGroups(next)
    localStorage.setItem('feather-project-groups', JSON.stringify(next))
  }
  function selectProject(id: string | null) {
    setCurrentProject(id)
    if (id) localStorage.setItem('feather-project', id)
    else localStorage.removeItem('feather-project')
  }
  interface AutoInstance {
    name: string; dir: string; running: boolean; current: string;
    keeps: number; reverts: number; crashes: number; skips: number; iterations: number;
    last: { timestamp: string; status: string; description: string } | null;
    mainChat: string | null;
    mtime?: number;
  }
  interface WorkerSession { id: string; agent: string; mtime: string }
  const [autoInstances, setAutoInstances] = createSignal<AutoInstance[]>([])
  const [currentAuto, setCurrentAuto] = createSignal<string | null>(null)
  const [autoDetail, setAutoDetail] = createSignal<(AutoInstance & { program?: string; results?: string; workerSessions?: WorkerSession[] }) | null>(null)
  const [autoNewName, setAutoNewName] = createSignal('')
  const [autoNewGoal, setAutoNewGoal] = createSignal('')
  const [autoCreating, setAutoCreating] = createSignal(false)
  const [autoBusy, setAutoBusy] = createSignal<string | null>(null)
  interface CosWorkstream {
    id: string; name: string; goal: string; launcher: 'session' | 'auto' | 'goal'; status: string;
    agent?: string; repo?: string; sessionId?: string; autoName?: string; goalPath?: string; goalCommand?: string;
    createdAt: string; updatedAt: string; lastCheckedAt?: string | null; lastReceipt?: string | null;
  }
  interface CosState { chiefSessionId: string | null; workstreams: CosWorkstream[]; msgvault?: boolean; tgIn?: boolean }
  const [cosState, setCosState] = createSignal<CosState>({ chiefSessionId: null, workstreams: [] })
  const [currentCos, setCurrentCos] = createSignal<string | null>(null)
  const [cosNewName, setCosNewName] = createSignal('')
  const [cosNewGoal, setCosNewGoal] = createSignal('')
  const [cosLauncher, setCosLauncher] = createSignal<'session' | 'auto' | 'goal'>('goal')
  const [cosRepo, setCosRepo] = createSignal('/home/user/feather')
  const [cosCreating, setCosCreating] = createSignal(false)
  const [cosBusy, setCosBusy] = createSignal<string | null>(null)
  function autoLastTs(i: AutoInstance): number {
    const lastTs = i.last ? new Date(i.last.timestamp).getTime() : 0
    return Math.max(lastTs, i.mtime || 0)
  }
  const sortedAutos = () => [...autoInstances()].sort((a, b) => autoLastTs(b) - autoLastTs(a))
  async function loadAutoInstances() {
    try {
      const r = await fetch(`${BASE}/api/auto/instances`)
      const d = await r.json()
      setAutoInstances(d.instances || [])
    } catch {}
  }
  async function loadAutoDetail(name: string) {
    try {
      const r = await fetch(`${BASE}/api/auto/instances/${name}`)
      if (r.ok) setAutoDetail(await r.json())
    } catch {}
  }
  async function autoAction(name: string, action: 'start' | 'stop') {
    setAutoBusy(name + ':' + action)
    try { await fetch(`${BASE}/api/auto/instances/${name}/${action}`, { method: 'POST' }); await loadAutoInstances() }
    finally { setAutoBusy(null) }
  }
  async function autoFocus(name: string, focus: string) {
    if (!focus.trim()) return
    await fetch(`${BASE}/api/auto/instances/${name}/focus`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ focus }) })
    await loadAutoInstances()
  }
  async function autoBtw(name: string, note: string) {
    if (!note.trim()) return
    await fetch(`${BASE}/api/auto/instances/${name}/btw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) })
    await loadAutoInstances()
  }
  async function autoLink(name: string, sessionId: string) {
    await fetch(`${BASE}/api/auto/instances/${name}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) })
    await loadAutoInstances()
  }
  async function autoCreate() {
    const name = autoNewName().trim()
    const goal = autoNewGoal().trim()
    if (!name || !goal) return
    setAutoCreating(true)
    try {
      const r = await fetch(`${BASE}/api/auto/instances`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, template: 'simple', goal }) })
      if (!r.ok) { const e = await r.json().catch(() => ({})); alert('Create failed: ' + (e.error || r.status)); return }
      try {
        const sessionId = await createSession(undefined, 'claude')
        await fetch(`${BASE}/api/auto/instances/${name}/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) })
        refreshSessions()
      } catch {}
      setAutoNewName(''); setAutoNewGoal('')
      await loadAutoInstances()
      setCurrentAuto(name)
      setCurrentCos(null)
      setSidebar(false)
    } finally { setAutoCreating(false) }
  }
  async function loadCos() {
    try {
      const r = await fetch(`${BASE}/api/cos`)
      if (r.ok) setCosState(await r.json())
    } catch {}
  }
  async function startChief() {
    setCosBusy('chief')
    try {
      const r = await fetch(`${BASE}/api/cos/chief`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'codex' }) })
      const d = await r.json()
      await loadCos()
      if (d.sessionId) select(d.sessionId)
    } finally { setCosBusy(null) }
  }
  async function cosCreate() {
    const name = cosNewName().trim()
    const goal = cosNewGoal().trim()
    if (!name || !goal) return
    setCosCreating(true)
    try {
      const r = await fetch(`${BASE}/api/cos/workstreams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, goal, launcher: cosLauncher(), repo: cosRepo(), agent: 'codex', start: true }),
      })
      if (!r.ok) { const e = await r.json().catch(() => ({})); alert('Launch failed: ' + (e.error || r.status)); return }
      const d = await r.json()
      setCosNewName(''); setCosNewGoal('')
      await loadCos()
      setCurrentCos(d.workstream?.id || null)
      setCurrentAuto(null)
      setSidebar(false)
    } finally { setCosCreating(false) }
  }
  async function cosCheck(id: string) {
    setCosBusy(id)
    try {
      await fetch(`${BASE}/api/cos/workstreams/${id}/check`, { method: 'POST' })
      await loadCos()
    } finally { setCosBusy(null) }
  }
  function openCos(w: CosWorkstream) {
    setCurrentCos(w.id)
    setCurrentAuto(null)
    setSidebar(false)
  }
  const [links, setLinks] = createSignal<QuickLink[]>([])
  const [starred, setStarred] = createSignal<Record<string, string[]>>({})
  const [expanded, setExpanded] = createSignal(false)
  const [agents, setAgents] = createSignal<AgentInfo[]>([])
  const [agentDropdown, setAgentDropdown] = createSignal(false)
  let cleanupSSE: (() => void) | null = null
  let sessionPoll: ReturnType<typeof setInterval> | undefined
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
    const added: PendingFile[] = []
    for (const f of fileList) {
      const isImage = f.type.startsWith('image/')
      const blob = isImage ? await resizeImage(f) : f
      const dataUrl = await new Promise<string>(r => { const rd = new FileReader(); rd.onload = () => r(rd.result as string); rd.readAsDataURL(blob) })
      added.push({ name: f.name, blob, dataUrl, isImage })
    }
    setFiles(prev => [...prev, ...added])
  }

  function removeFile(idx: number) { setFiles(prev => prev.filter((_, i) => i !== idx)) }

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
    fetchProjects().then(setProjects).catch(() => {})
    const base = location.pathname.replace(/\/+$/, '')
    fetch(`${base}/api/quick-links`).then(r => r.json()).then(setLinks).catch(() => {})
    fetchStarred().then(setStarred).catch(() => {})
    if (boxMatch) select(boxMatch[2])
    else if (hash) select(hash)
    // Refresh session list when tab becomes visible
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('feather:open-path', onOpenPath)
    // Poll the session list so active/idle (green dot) status stays fresh
    // without needing a manual action. Skip while the tab is hidden.
    sessionPoll = setInterval(() => { if (document.visibilityState === 'visible') refreshSessions() }, 15000)
    // Prefetch Terminal chunk during idle so the tab click feels instant
    const idle = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 2000))
    idle(() => { import('./components/Terminal').catch(() => {}) })
  })
  function onVisibility() {
    if (document.visibilityState === 'visible') refreshSessions()
  }
  onCleanup(() => { cleanupSSE?.(); if (sessionPoll) clearInterval(sessionPoll); document.removeEventListener('keydown', onGlobalKeyDown); document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('feather:open-path', onOpenPath) })

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
    setCurrentBox(id)
    setPeerControl(false)
    setCurrentId(null)
    cleanupSSE?.()
    setMessages([])
    setTab('chat')
    location.hash = ''
    setSessions([])
    refreshSessions()
  }

  async function select(id: string) {
    const prev = currentId()
    if (prev) saveDraft(prev, text())
    setCurrentAuto(null)
    setCurrentCos(null)
    setCurrentId(id)
    location.hash = currentBox() === 'local' ? id : `${currentBox()}:${id}`
    setSidebar(false)
    setLoading(true)
    setMessages([])
    setWorking(false)
    setText(loadDraft(id))
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
    if (!listening()) return 'Record voice memo'
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
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' })
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data) }
    mediaRecorder.onstop = async () => {
      const blob = new Blob(audioChunks, { type: mediaRecorder!.mimeType })
      const sendAfterTranscription = spinSendAfterStop
      stopVoice()
      if (blob.size < 1000) return // too short, ignore

      setTranscribing(true)
      try {
        const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob })
        const data = await res.json()
        if (data.transcript) {
          const transcript = String(data.transcript).trim()
          if (!transcript) return
          const prev = text().trim()
          if (sendAfterTranscription) await sendSessionText(transcript)
          else setText(prev ? prev + ' ' + transcript : transcript)
        } else if (data.error) {
          console.error('Transcription error:', data.error)
        }
      } catch (err) {
        console.error('Transcription failed:', err)
        // Offer download so audio isn't lost
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = `voice-memo-${Date.now()}.webm`; a.click()
        URL.revokeObjectURL(url)
      } finally {
        setTranscribing(false)
      }
    }
    mediaRecorder.start(1000) // collect chunks every second
  }

  async function sendSessionText(rawText: string, clearDraft = false) {
    const fullText = rawText.trim()
    if (!fullText || !currentId()) return
    pushHistory(fullText)
    if (clearDraft) saveDraft(currentId()!, '')

    // No optimistic echo on peer boxes: the owner's server prefixes our name
    // ([allan] …), so the streamed-back text wouldn't match and we'd show a dupe
    if (!isPeerBox()) {
      const tempId = `optimistic-${Date.now()}`
      setMessages(prev => [...prev, {
        uuid: tempId, role: 'user', timestamp: new Date().toISOString(),
        content: [{ type: 'text', text: fullText }], delivery: 'sent',
      }])
    }
    sendInput(currentId()!, fullText, currentBox())
    setWorking(true)
  }

  async function sendComposedMessage(rawText: string, pending: PendingFile[] = files()) {
    const val = rawText.trim()
    if ((!val && !pending.length) || !currentId()) return
    setUploading(true)
    setText('')
    setFiles([])
    if (textareaRef) { textareaRef.style.height = 'auto'; textareaRef.blur() }
    const parts: string[] = val ? [val] : []
    for (const f of pending) {
      try {
        const uploadPath = await uploadFile(f.blob, f.name)
        parts.push(f.isImage ? `[Attached image: ${uploadPath}]` : `[Attached file: ${uploadPath}] (${f.name})`)
      } catch { parts.push(`[Upload failed: ${f.name}]`) }
    }
    await sendSessionText(parts.join('\n'), true)
    setUploading(false)
  }

  async function handleSend() {
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
    const needList = (sidebarTab() === 'auto' && sidebar()) || currentAuto() !== null
    if (!needList) return
    loadAutoInstances()
    const id = setInterval(loadAutoInstances, 5000)
    onCleanup(() => clearInterval(id))
  })

  createEffect(() => {
    const needList = (sidebarTab() === 'cos' && sidebar()) || currentCos() !== null
    if (!needList) return
    loadCos()
    const id = setInterval(loadCos, 5000)
    onCleanup(() => clearInterval(id))
  })

  createEffect(() => {
    const name = currentAuto()
    if (!name) { setAutoDetail(null); return }
    loadAutoDetail(name)
    const id = setInterval(() => loadAutoDetail(name), 4000)
    onCleanup(() => clearInterval(id))
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
            <span style={{ 'font-weight': '700', 'font-size': '16px' }}>Feather</span>
            <button onClick={() => setSidebar(false)} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '20px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent', padding: '4px 8px' }}>&times;</button>
          </div>
          {/* Sidebar tabs */}
          <div style={{ display: 'flex', 'border-bottom': '1px solid #1e1e1e' }}>
            <button onClick={() => setSidebarTab('sessions')} style={{ flex: '1', padding: '8px', border: 'none', 'border-bottom': sidebarTab() === 'sessions' ? '2px solid #4aba6a' : '2px solid transparent', background: 'none', color: sidebarTab() === 'sessions' ? '#e5e5e5' : '#666', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Sessions</button>
            <button onClick={() => setSidebarTab('cos')} style={{ flex: '1', padding: '8px', border: 'none', 'border-bottom': sidebarTab() === 'cos' ? '2px solid #4aba6a' : '2px solid transparent', background: 'none', color: sidebarTab() === 'cos' ? '#e5e5e5' : '#666', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>CoS</button>
            <button onClick={() => setSidebarTab('auto')} style={{ flex: '1', padding: '8px', border: 'none', 'border-bottom': sidebarTab() === 'auto' ? '2px solid #4aba6a' : '2px solid transparent', background: 'none', color: sidebarTab() === 'auto' ? '#e5e5e5' : '#666', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Auto</button>
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
            {/* Project tree (collapsed by default) */}
            <div style={{ 'border-bottom': '1px solid #1e1e1e', padding: '4px 0' }}>
              <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', padding: '4px 16px' }}>
                <div onClick={() => setProjectsExpanded(!projectsExpanded())}
                  style={{ cursor: 'pointer', 'font-size': '11px', 'font-weight': '600', color: '#777', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', '-webkit-tap-highlight-color': 'transparent', display: 'flex', 'align-items': 'center', gap: '4px' }}>
                  <span style={{ 'font-size': '8px', transition: 'transform 0.15s', transform: projectsExpanded() ? 'rotate(90deg)' : 'none' }}>&#9654;</span>
                  Projects
                </div>
                <Show when={currentProject()}>
                  <span style={{ 'font-size': '11px', color: '#4aba6a', 'font-weight': '600' }}>
                    {projects().find(p => p.id === currentProject())?.label || ''}
                  </span>
                  <span onClick={(e) => { e.stopPropagation(); selectProject(null) }}
                    style={{ 'font-size': '10px', color: '#666', cursor: 'pointer', padding: '0 4px' }}>&times;</span>
                </Show>
              </div>
              <Show when={projectsExpanded()}>
                <div style={{ 'max-height': '35vh', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch' }}>
                  <div onClick={() => { selectProject(null); setProjectsExpanded(false) }}
                    style={{ padding: '4px 16px', cursor: 'pointer', 'font-size': '11px', 'font-weight': '600', color: currentProject() === null ? '#4aba6a' : '#888', '-webkit-tap-highlight-color': 'transparent' }}>
                    All
                  </div>
                  {(() => {
                    const grouped: Record<string, Project[]> = {}
                    const ungrouped: Project[] = []
                    for (const p of projects()) {
                      const idx = p.label.indexOf(' / ')
                      if (idx >= 0) {
                        const g = p.label.substring(0, idx)
                        ;(grouped[g] ||= []).push(p)
                      } else {
                        ungrouped.push(p)
                      }
                    }
                    return <>
                      <For each={Object.keys(grouped).sort()}>{(group) => <>
                        <div onClick={() => toggleGroup(group)}
                          style={{ display: 'flex', 'align-items': 'center', gap: '4px', padding: '3px 16px', cursor: 'pointer', 'font-size': '11px', color: '#888', 'font-weight': '600', '-webkit-tap-highlight-color': 'transparent' }}>
                          <span style={{ 'font-size': '7px', transition: 'transform 0.15s', transform: expandedGroups()[group] ? 'rotate(90deg)' : 'none' }}>&#9654;</span>
                          {group}
                          <span style={{ color: '#444', 'font-weight': '400' }}>({grouped[group].length})</span>
                        </div>
                        <Show when={expandedGroups()[group]}>
                          <For each={grouped[group]}>{(p) => (
                            <div onClick={() => selectProject(p.id)}
                              style={{ padding: '3px 16px 3px 32px', cursor: 'pointer', 'font-size': '12px', color: currentProject() === p.id ? '#4aba6a' : '#aaa', 'font-weight': currentProject() === p.id ? '600' : '400', '-webkit-tap-highlight-color': 'transparent' }}>
                              {p.label.substring(group.length + 3)}
                            </div>
                          )}</For>
                        </Show>
                      </>}</For>
                      <For each={ungrouped}>{(p) => (
                        <div onClick={() => selectProject(p.id)}
                          style={{ padding: '3px 16px', cursor: 'pointer', 'font-size': '12px', color: currentProject() === p.id ? '#4aba6a' : '#aaa', 'font-weight': currentProject() === p.id ? '600' : '400', '-webkit-tap-highlight-color': 'transparent' }}>
                          {p.label}
                        </div>
                      )}</For>
                    </>
                  })()}
                </div>
              </Show>
            </div>
            </Show>
            <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', 'padding-bottom': 'env(safe-area-inset-bottom)' }}>
              {(() => {
                const all = sessions().filter(s => !s.isWorker && (!currentProject() || s.projectId === currentProject()))
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
                return <For each={groups.filter(g => g.items.length > 0)}>{(group) => <>
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
                        <Show when={!currentProject() && s.projectLabel}>
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
                    </div>
                  )}</For>
                </>}</For>
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
          {/* CoS tab */}
          <Show when={sidebarTab() === 'cos'}>
            <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', 'padding-bottom': 'env(safe-area-inset-bottom)' }}>
              <div style={{ padding: '12px 16px', 'border-bottom': '1px solid #1e1e1e' }}>
                <button onClick={startChief} disabled={cosBusy() === 'chief'} style={{ width: '100%', padding: '7px', background: cosBusy() === 'chief' ? '#1a1a2e' : '#4aba6a', color: cosBusy() === 'chief' ? '#666' : '#000', border: 'none', 'border-radius': '6px', 'font-size': '12px', 'font-weight': '600', cursor: cosBusy() === 'chief' ? 'wait' : 'pointer', 'margin-bottom': '8px' }}>{cosState().chiefSessionId ? 'Open Chief' : 'Start Chief'}</button>
                <input value={cosNewName()} onInput={(e) => setCosNewName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="workstream" style={{ width: '100%', padding: '6px 8px', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '6px', color: '#e5e5e5', 'font-size': '12px', 'margin-bottom': '6px', outline: 'none' }} />
                <textarea value={cosNewGoal()} onInput={(e) => setCosNewGoal(e.target.value)} placeholder="goal" rows={3} style={{ width: '100%', padding: '6px 8px', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '6px', color: '#e5e5e5', 'font-size': '12px', resize: 'vertical', 'font-family': 'inherit', outline: 'none', 'margin-bottom': '6px' }} />
                <div style={{ display: 'flex', gap: '6px', 'margin-bottom': '6px' }}>
                  <select value={cosLauncher()} onChange={(e) => setCosLauncher(e.currentTarget.value as 'session' | 'auto' | 'goal')} style={{ flex: '0 0 86px', padding: '6px 8px', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '6px', color: '#e5e5e5', 'font-size': '12px', outline: 'none' }}>
                    <option value="goal">goal</option>
                    <option value="auto">auto</option>
                    <option value="session">session</option>
                  </select>
                  <input value={cosRepo()} onInput={(e) => setCosRepo(e.target.value)} placeholder="/home/user/feather" style={{ flex: '1', 'min-width': '0', padding: '6px 8px', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '6px', color: '#e5e5e5', 'font-size': '12px', outline: 'none' }} />
                </div>
                <button onClick={cosCreate} disabled={cosCreating() || !cosNewName() || !cosNewGoal()} style={{ width: '100%', padding: '7px', background: cosCreating() ? '#1a1a2e' : '#4aba6a', color: cosCreating() ? '#666' : '#000', border: 'none', 'border-radius': '6px', 'font-size': '12px', 'font-weight': '600', cursor: cosCreating() ? 'wait' : 'pointer' }}>{cosCreating() ? 'Launching...' : '+ Workstream'}</button>
              </div>
              <Show when={cosState().workstreams.length === 0}>
                <div style={{ padding: '20px 16px', color: '#555', 'font-size': '13px' }}>No workstreams.</div>
              </Show>
              <For each={cosState().workstreams}>{(w) => (
                <div onClick={() => openCos(w)}
                  style={{ padding: '10px 16px', cursor: 'pointer', 'border-bottom': '1px solid #111', 'border-left': currentCos() === w.id ? '3px solid #4aba6a' : '3px solid transparent', background: currentCos() === w.id ? '#1a1a2e' : 'transparent', '-webkit-tap-highlight-color': 'transparent' }}>
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                    <span style={{ width: '8px', height: '8px', 'border-radius': '50%', background: w.status === 'running' ? '#4aba6a' : w.status === 'idle' ? '#73b8ff' : '#555', 'flex-shrink': '0' }} />
                    <span style={{ 'font-size': '13px', 'font-weight': '600', flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{w.name}</span>
                    <span style={{ 'font-size': '9px', padding: '1px 5px', 'border-radius': '3px', background: '#1e1e1e', color: '#888', 'flex-shrink': '0', 'font-weight': '600' }}>{w.launcher}</span>
                  </div>
                  <div style={{ 'font-size': '10px', color: '#555', 'margin-top': '2px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{w.lastReceipt || w.status}</div>
                </div>
              )}</For>
            </div>
          </Show>
          {/* Auto tab */}
          <Show when={sidebarTab() === 'auto'}>
            <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', 'padding-bottom': 'env(safe-area-inset-bottom)' }}>
              <div style={{ padding: '12px 16px', 'border-bottom': '1px solid #1e1e1e' }}>
                <input value={autoNewName()} onInput={(e) => setAutoNewName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="name (lowercase)" style={{ width: '100%', padding: '6px 8px', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '6px', color: '#e5e5e5', 'font-size': '12px', 'margin-bottom': '6px', outline: 'none' }} />
                <textarea value={autoNewGoal()} onInput={(e) => setAutoNewGoal(e.target.value)} placeholder="goal (what should it loop on?)" rows={2} style={{ width: '100%', padding: '6px 8px', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '6px', color: '#e5e5e5', 'font-size': '12px', resize: 'vertical', 'font-family': 'inherit', outline: 'none' }} />
                <button onClick={autoCreate} disabled={autoCreating() || !autoNewName() || !autoNewGoal()} style={{ width: '100%', 'margin-top': '6px', padding: '6px', background: autoCreating() ? '#1a1a2e' : '#4aba6a', color: autoCreating() ? '#666' : '#000', border: 'none', 'border-radius': '6px', 'font-size': '12px', 'font-weight': '600', cursor: autoCreating() ? 'wait' : 'pointer' }}>{autoCreating() ? 'Creating...' : '+ New auto'}</button>
              </div>
              <Show when={autoInstances().length === 0}>
                <div style={{ padding: '20px 16px', color: '#555', 'font-size': '13px' }}>No autos yet.</div>
              </Show>
              <For each={sortedAutos()}>{(inst) => (
                <div onClick={() => { setCurrentAuto(inst.name); setCurrentCos(null); setSidebar(false) }}
                  style={{ padding: '10px 16px', cursor: 'pointer', 'border-bottom': '1px solid #111', 'border-left': currentAuto() === inst.name ? '3px solid #4aba6a' : '3px solid transparent', background: currentAuto() === inst.name ? '#1a1a2e' : 'transparent', '-webkit-tap-highlight-color': 'transparent' }}>
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '6px' }}>
                    <span style={{ width: '8px', height: '8px', 'border-radius': '50%', background: inst.running ? '#4aba6a' : '#555', 'flex-shrink': '0' }} />
                    <span style={{ 'font-size': '13px', 'font-weight': '600', flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{inst.name}</span>
                    <span style={{ 'font-size': '10px', color: '#888', 'flex-shrink': '0' }}>k{inst.keeps}/r{inst.reverts}/c{inst.crashes}</span>
                  </div>
                  <Show when={inst.last}>
                    <div style={{ 'font-size': '10px', color: '#555', 'margin-top': '2px' }}>{timeAgo(inst.last!.timestamp)} ago — {inst.last!.status}</div>
                  </Show>
                </div>
              )}</For>
            </div>
          </Show>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-width': '0', height: '100%' }}>
        <Show when={currentAuto()}>{(name) => {
          const inst = () => autoDetail() || autoInstances().find(i => i.name === name())
          const recent = () => {
            const r = autoDetail()?.results
            if (!r) return [] as { ts: string; status: string; desc: string }[]
            return r.split('\n').slice(1).filter(Boolean).slice(-15).reverse().map(line => {
              const [ts, status, ...rest] = line.split('\t')
              return { ts, status, desc: rest.join('\t') }
            })
          }
          return (
            <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'padding-top': 'max(8px, env(safe-area-inset-top))' }}>
              <div style={{ padding: '12px 24px 12px 56px', 'border-bottom': '1px solid #1e1e1e', display: 'flex', 'align-items': 'center', gap: '12px', 'flex-wrap': 'wrap' }}>
                <span style={{ width: '12px', height: '12px', 'border-radius': '50%', background: inst()?.running ? '#4aba6a' : '#555' }} />
                <span style={{ 'font-size': '20px', 'font-weight': '700' }}>{name()}</span>
                <span style={{ 'font-size': '12px', color: '#888', padding: '2px 8px', background: '#1a1a2e', 'border-radius': '4px' }}>{inst()?.running ? 'RUNNING' : 'STOPPED'}</span>
                <div style={{ flex: '1' }} />
                <Show when={inst()?.mainChat}>
                  <button onClick={(e) => { e.preventDefault(); select(inst()!.mainChat!) }} style={{ background: 'none', border: '1px solid #2a3a55', color: '#73b8ff', padding: '4px 10px', 'border-radius': '6px', 'font-size': '13px', cursor: 'pointer' }}>→ main chat</button>
                </Show>
                <button onClick={() => setCurrentAuto(null)} style={{ background: 'none', border: 'none', color: '#888', 'font-size': '20px', cursor: 'pointer', padding: '4px 8px' }}>×</button>
              </div>
              <div style={{ padding: '20px 24px 20px 56px', 'max-width': '900px' }}>
                <div style={{ display: 'grid', 'grid-template-columns': 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px', 'margin-bottom': '20px' }}>
                  <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', padding: '12px' }}>
                    <div style={{ 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>Iterations</div>
                    <div style={{ 'font-size': '24px', 'font-weight': '700', 'margin-top': '4px' }}>{inst()?.iterations ?? 0}</div>
                  </div>
                  <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', padding: '12px' }}>
                    <div style={{ 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>Keeps</div>
                    <div style={{ 'font-size': '24px', 'font-weight': '700', color: '#4aba6a', 'margin-top': '4px' }}>{inst()?.keeps ?? 0}</div>
                  </div>
                  <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', padding: '12px' }}>
                    <div style={{ 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>Reverts</div>
                    <div style={{ 'font-size': '24px', 'font-weight': '700', color: '#d4a050', 'margin-top': '4px' }}>{inst()?.reverts ?? 0}</div>
                  </div>
                  <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', padding: '12px' }}>
                    <div style={{ 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>Crashes</div>
                    <div style={{ 'font-size': '24px', 'font-weight': '700', color: '#d45555', 'margin-top': '4px' }}>{inst()?.crashes ?? 0}</div>
                  </div>
                </div>
                <Show when={inst()?.current}>
                  <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', padding: '12px 16px', 'margin-bottom': '16px', 'font-size': '13px', color: '#aaa' }}>
                    <span style={{ color: '#666', 'font-size': '11px', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', 'margin-right': '8px' }}>Now</span>
                    {inst()!.current}
                  </div>
                </Show>
                <div style={{ display: 'flex', gap: '8px', 'margin-bottom': '16px' }}>
                  <Show when={!inst()?.running} fallback={
                    <button onClick={() => autoAction(name(), 'stop')} disabled={autoBusy() !== null} style={{ padding: '10px 20px', background: '#d45555', color: '#fff', border: 'none', 'border-radius': '8px', 'font-size': '14px', 'font-weight': '600', cursor: 'pointer' }}>{autoBusy() === name() + ':stop' ? '...' : 'Stop'}</button>
                  }>
                    <button onClick={() => autoAction(name(), 'start')} disabled={autoBusy() !== null} style={{ padding: '10px 20px', background: '#4aba6a', color: '#000', border: 'none', 'border-radius': '8px', 'font-size': '14px', 'font-weight': '600', cursor: 'pointer' }}>{autoBusy() === name() + ':start' ? '...' : 'Start'}</button>
                  </Show>
                  <Show when={!inst()?.mainChat}>
                    <button onClick={() => { const id = currentId(); if (id) autoLink(name(), id); else alert('Open a chat first to link.') }} style={{ padding: '10px 16px', background: 'none', border: '1px solid #333', 'border-radius': '8px', color: '#888', 'font-size': '13px', cursor: 'pointer' }}>Link current chat</button>
                  </Show>
                </div>
                <div style={{ 'margin-bottom': '16px' }}>
                  <div style={{ 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', 'margin-bottom': '6px' }}>Set focus</div>
                  <input placeholder="What should it work on next?" onKeyDown={async (e) => { if (e.key === 'Enter') { await autoFocus(name(), e.currentTarget.value); e.currentTarget.value = '' } }} style={{ width: '100%', padding: '10px 12px', background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', color: '#e5e5e5', 'font-size': '13px', outline: 'none' }} />
                </div>
                <div style={{ 'margin-bottom': '24px' }}>
                  <div style={{ 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', 'margin-bottom': '6px' }}>BTW (heads-up to the worker)</div>
                  <input placeholder="Add a note for the next iteration..." onKeyDown={async (e) => { if (e.key === 'Enter') { await autoBtw(name(), e.currentTarget.value); e.currentTarget.value = ''; loadAutoDetail(name()) } }} style={{ width: '100%', padding: '10px 12px', background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', color: '#e5e5e5', 'font-size': '13px', outline: 'none' }} />
                </div>
                <Show when={recent().length > 0}>
                  <div style={{ 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', 'margin-bottom': '8px' }}>Recent activity</div>
                  <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', overflow: 'hidden' }}>
                    <For each={recent()}>{(r) => (
                      <div style={{ padding: '8px 12px', 'border-bottom': '1px solid #1a1a2e', 'font-size': '12px', display: 'flex', gap: '8px', 'align-items': 'flex-start' }}>
                        <span style={{ color: '#555', 'flex-shrink': '0', 'font-family': 'monospace' }}>{timeAgo(r.ts)}</span>
                        <span style={{ color: r.status === 'keep' ? '#4aba6a' : r.status === 'revert' ? '#d4a050' : '#d45555', 'font-weight': '600', 'flex-shrink': '0', 'min-width': '50px' }}>{r.status}</span>
                        <span style={{ color: '#aaa', flex: '1', 'word-break': 'break-word' }}>{r.desc}</span>
                      </div>
                    )}</For>
                  </div>
                </Show>
                <Show when={autoDetail()?.workerSessions && autoDetail()!.workerSessions!.length > 0}>
                  <div style={{ 'margin-top': '24px', 'margin-bottom': '8px', 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>Worker sessions</div>
                  <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', overflow: 'hidden' }}>
                    <For each={autoDetail()!.workerSessions!}>{(w) => (
                      <div onClick={() => select(w.id)} style={{ padding: '8px 12px', 'border-bottom': '1px solid #1a1a2e', 'font-size': '12px', display: 'flex', gap: '8px', 'align-items': 'center', cursor: 'pointer' }}>
                        <span style={{ color: '#555', 'flex-shrink': '0', 'font-family': 'monospace', 'min-width': '34px' }}>{timeAgo(w.mtime)}</span>
                        <span style={{ 'font-size': '9px', padding: '1px 5px', 'border-radius': '3px', background: w.agent === 'codex' ? '#2a1e3a' : '#1e2a3a', color: w.agent === 'codex' ? '#c084fc' : '#73b8ff', 'flex-shrink': '0', 'font-weight': '600' }}>{w.agent}</span>
                        <span style={{ color: '#888', 'font-family': 'monospace', 'font-size': '11px' }}>{w.id.slice(0, 8)}</span>
                      </div>
                    )}</For>
                  </div>
                </Show>
                <Show when={autoDetail()?.program}>
                  <div style={{ 'margin-top': '24px', 'margin-bottom': '8px', 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>Program</div>
                  <div class="prose" style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', padding: '4px 20px', color: '#d0d0d0', 'font-size': '14px', 'line-height': '1.55' }} innerHTML={marked.parse(autoDetail()!.program!) as string} />
                </Show>
              </div>
            </div>
          )
        }}</Show>
        <Show when={currentCos()}>{(id) => {
          const w = () => cosState().workstreams.find(x => x.id === id())
          return (
            <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'padding-top': 'max(8px, env(safe-area-inset-top))' }}>
              <div style={{ padding: '12px 24px 12px 56px', 'border-bottom': '1px solid #1e1e1e', display: 'flex', 'align-items': 'center', gap: '12px', 'flex-wrap': 'wrap' }}>
                <span style={{ width: '12px', height: '12px', 'border-radius': '50%', background: w()?.status === 'running' ? '#4aba6a' : w()?.status === 'idle' ? '#73b8ff' : '#555' }} />
                <span style={{ 'font-size': '20px', 'font-weight': '700' }}>{w()?.name || 'workstream'}</span>
                <span style={{ 'font-size': '12px', color: '#888', padding: '2px 8px', background: '#1a1a2e', 'border-radius': '4px' }}>{w()?.status || 'unknown'}</span>
                <div style={{ flex: '1' }} />
                <button onClick={() => setCurrentCos(null)} style={{ background: 'none', border: 'none', color: '#888', 'font-size': '20px', cursor: 'pointer', padding: '4px 8px' }}>×</button>
              </div>
              <div style={{ padding: '20px 24px 20px 56px', 'max-width': '900px' }}>
                <Show when={w()} fallback={<div style={{ color: '#555', 'font-size': '13px' }}>Missing workstream.</div>}>{(ws) => (
                  <>
                    <div style={{ display: 'grid', 'grid-template-columns': 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px', 'margin-bottom': '20px' }}>
                      <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', padding: '12px' }}>
                        <div style={{ 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>Launcher</div>
                        <div style={{ 'font-size': '18px', 'font-weight': '700', 'margin-top': '4px' }}>{ws().launcher}</div>
                      </div>
                      <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', padding: '12px' }}>
                        <div style={{ 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>Agent</div>
                        <div style={{ 'font-size': '18px', 'font-weight': '700', 'margin-top': '4px' }}>{ws().agent || 'auto'}</div>
                      </div>
                      <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', padding: '12px' }}>
                        <div style={{ 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>Updated</div>
                        <div style={{ 'font-size': '18px', 'font-weight': '700', 'margin-top': '4px' }}>{timeAgo(ws().updatedAt)}</div>
                      </div>
                    </div>
                    <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', padding: '12px 16px', 'margin-bottom': '16px', 'font-size': '13px', color: '#aaa', 'line-height': '1.45' }}>
                      <div style={{ color: '#666', 'font-size': '11px', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', 'margin-bottom': '6px' }}>Goal</div>
                      {ws().goal}
                    </div>
                    <Show when={ws().lastReceipt}>
                      <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', padding: '12px 16px', 'margin-bottom': '16px', 'font-size': '13px', color: '#aaa' }}>
                        <span style={{ color: '#666', 'font-size': '11px', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', 'margin-right': '8px' }}>Receipt</span>
                        {ws().lastReceipt}
                      </div>
                    </Show>
                    <div style={{ display: 'flex', gap: '8px', 'margin-bottom': '16px', 'flex-wrap': 'wrap' }}>
                      <button onClick={() => cosCheck(ws().id)} disabled={cosBusy() !== null} style={{ padding: '10px 16px', background: '#4aba6a', color: '#000', border: 'none', 'border-radius': '8px', 'font-size': '14px', 'font-weight': '600', cursor: cosBusy() ? 'wait' : 'pointer' }}>{cosBusy() === ws().id ? '...' : 'Check'}</button>
                      <Show when={ws().sessionId}>
                        <button onClick={() => select(ws().sessionId!)} style={{ padding: '10px 16px', background: 'none', border: '1px solid #2a3a55', 'border-radius': '8px', color: '#73b8ff', 'font-size': '13px', cursor: 'pointer' }}>Open session</button>
                      </Show>
                      <Show when={ws().autoName}>
                        <button onClick={() => { setCurrentAuto(ws().autoName!); setCurrentCos(null) }} style={{ padding: '10px 16px', background: 'none', border: '1px solid #2a3a55', 'border-radius': '8px', color: '#73b8ff', 'font-size': '13px', cursor: 'pointer' }}>Open auto</button>
                      </Show>
                    </div>
                    <Show when={ws().goalCommand}>
                      <div style={{ 'font-size': '11px', color: '#666', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', 'margin-bottom': '8px' }}>Goal command</div>
                      <pre style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '8px', padding: '12px', color: '#d0d0d0', 'font-size': '12px', overflow: 'auto' }}>{ws().goalCommand}</pre>
                    </Show>
                    <div style={{ 'font-size': '11px', color: '#555', 'font-family': "'SF Mono', Menlo, monospace", 'margin-top': '16px', 'word-break': 'break-all' }}>{ws().repo}</div>
                  </>
                )}</Show>
              </div>
            </div>
          )
        }}</Show>
        <Show when={!currentAuto() && !currentCos()}>
        {/* Header */}
        <div style={{ padding: '8px 16px 0 56px', 'padding-top': 'max(8px, env(safe-area-inset-top))', 'border-bottom': '1px solid #1e1e1e', display: 'flex', 'align-items': 'center', gap: '8px', 'min-height': '48px', 'flex-shrink': '0' }}>
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
                    <a href={exportUrl(s().id, currentBox())} download style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer', 'text-decoration': 'none' }} onClick={() => setMenuOpen(false)}>Export MD</a>
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
            <Show when={!isRemoteBox()}>
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
            <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'center', height: '100%', color: '#444' }}>
              <div style={{ 'text-align': 'center' }}>
                <div style={{ 'font-size': '32px', 'margin-bottom': '12px', opacity: '0.3' }}>~</div>
                <div>Open a session or create a new one</div>
              </div>
            </div>
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
          </Show>
        </div>

        {/* File viewer modal */}
        <Show when={viewingFile()}>
          {(() => {
            const v = viewingFile()!
            const fileUrl = `${BASE}/api/file?path=${encodeURIComponent(v.path)}`
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
          <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) { addFiles(e.target.files); e.target.value = '' } }} />
          {/* File previews */}
          <Show when={files().length > 0}>
            <div style={{ padding: '6px 12px 0', 'border-top': '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', gap: '8px', 'flex-wrap': 'wrap' }}>
              <For each={files()}>{(f, i) => (
                <div style={{ position: 'relative', background: '#1a1a2e', 'border-radius': '8px', padding: '4px', border: '1px solid #333' }}>
                  {f.isImage
                    ? <img src={f.dataUrl} style={{ height: '56px', 'max-width': '100px', 'border-radius': '6px', 'object-fit': 'cover', display: 'block' }} />
                    : <div style={{ padding: '4px 8px', 'font-size': '11px', color: '#999', 'max-width': '100px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{f.name}</div>
                  }
                  <button onClick={() => removeFile(i())} style={{ position: 'absolute', top: '-6px', right: '-6px', width: '22px', height: '22px', 'border-radius': '50%', background: '#d45555', color: '#fff', border: 'none', 'font-size': '12px', cursor: 'pointer', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'line-height': '1' }}>&times;</button>
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
              <button onClick={() => fileInputRef?.click()} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '20px', cursor: 'pointer', padding: '8px 4px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '32px', 'min-height': '42px' }} title="Attach file">+</button>
              <button onClick={() => setHistoryOpen(!historyOpen())} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '16px', cursor: 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px' }} title="Message history">{'\u2191'}</button>
              <button onClick={toggleVoice} disabled={transcribing()} style={{ background: listening() ? `rgba(212, 85, 85, ${0.15 + audioLevel() * 0.35})` : 'none', border: listening() ? '1px solid #d45555' : 'none', 'border-radius': '8px', color: transcribing() ? '#c9a227' : listening() ? '#d45555' : '#666', 'font-size': '16px', cursor: transcribing() ? 'wait' : 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px', transition: 'all 0.15s' }} title={voiceTitle()} aria-label={voiceTitle()}>{transcribing() ? '\u23F3' : listening() ? '\u23F9' : '\uD83C\uDF99'}</button>
              <button onClick={() => { setExpanded(true); setTimeout(() => { if (textareaRef) { textareaRef.style.height = 'auto'; textareaRef.focus() } }, 10) }} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '14px', cursor: 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px' }} title="Expand editor">{'\u2922'}</button>
            </Show>
            <textarea ref={textareaRef} value={text()}
              onInput={(e) => { setText(e.target.value); if (!expanded()) { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px' } }}
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
                  <button onClick={() => fileInputRef?.click()} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '20px', cursor: 'pointer', padding: '8px 4px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '32px', 'min-height': '42px' }} title="Attach file">+</button>
                  <button onClick={() => setHistoryOpen(!historyOpen())} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '16px', cursor: 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px' }} title="Message history">{'\u2191'}</button>
                  <button onClick={toggleVoice} disabled={transcribing()} style={{ background: listening() ? `rgba(212, 85, 85, ${0.15 + audioLevel() * 0.35})` : 'none', border: listening() ? '1px solid #d45555' : 'none', 'border-radius': '8px', color: transcribing() ? '#c9a227' : listening() ? '#d45555' : '#666', 'font-size': '16px', cursor: transcribing() ? 'wait' : 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px', transition: 'all 0.15s' }} title={voiceTitle()} aria-label={voiceTitle()}>{transcribing() ? '\u23F3' : listening() ? '\u23F9' : '\uD83C\uDF99'}</button>
                  <button onClick={() => { setExpanded(false); setTimeout(() => { if (textareaRef) { textareaRef.style.height = 'auto'; textareaRef.style.height = Math.min(textareaRef.scrollHeight, 120) + 'px' } }, 10) }} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '14px', cursor: 'pointer', padding: '8px 6px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-height': '42px' }} title="Collapse">{'\u2193'} Collapse</button>
                </div>
              </Show>
              <button onClick={() => { handleSend(); setExpanded(false) }} disabled={uploading()} style={{ background: (text().trim() || files().length) ? '#4aba6a' : '#333', color: (text().trim() || files().length) ? '#000' : '#666', border: 'none', 'border-radius': '12px', padding: '10px 16px', 'font-size': '15px', 'font-weight': '600', cursor: (text().trim() || files().length) ? 'pointer' : 'default', 'min-height': '42px', '-webkit-tap-highlight-color': 'transparent' }}>{uploading() ? '...' : 'Send'}</button>
            </div>
          </div>
        </Show>
        </Show>
      </div>
    </div>
  )
}
