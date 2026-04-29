declare const __BUILD_TIME__: string
import { createSignal, createEffect, onMount, onCleanup, Show, For, lazy, Suspense } from 'solid-js'
import { marked } from 'marked'
import { MessageView } from './components/MessageView'
const Terminal = lazy(() => import('./components/Terminal').then(m => ({ default: m.Terminal })))
import type { SessionMeta, Message, AgentInfo } from './api'
import { fetchSessions, fetchMessages, subscribeMessages, sendInput, createSession, resumeSession, interruptSession, uploadFile, deleteSession, renameSession, fetchStarred, saveStarred, exportUrl, openInEditor, fetchAgents, BASE } from './api'

interface QuickLink { label: string; url: string }

interface PendingFile { name: string; blob: Blob; dataUrl: string; isImage: boolean }

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
  const [messages, setMessages] = createSignal<Message[]>([])
  const [sidebar, setSidebar] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [text, setText] = createSignal('')
  const [tab, setTab] = createSignal<'chat' | 'files' | 'terminal'>('chat')
  const [files, setFiles] = createSignal<PendingFile[]>([])
  const [viewingFile, setViewingFile] = createSignal<{ path: string; content: string; error?: string } | null>(null)
  async function openFile(path: string) {
    setViewingFile({ path, content: '' })
    try {
      const r = await fetch(`${BASE}/api/file?path=${encodeURIComponent(path)}`)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      setViewingFile({ path, content: await r.text() })
    } catch (e: any) {
      setViewingFile({ path, content: '', error: e.message || 'failed to load' })
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
  const [hasMore, setHasMore] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [renaming, setRenaming] = createSignal(false)
  const [renameText, setRenameText] = createSignal('')
  const [sidebarRenaming, setSidebarRenaming] = createSignal<string | null>(null)
  const [sidebarRenameText, setSidebarRenameText] = createSignal('')
  const [sidebarTab, setSidebarTab] = createSignal<'sessions' | 'links' | 'auto'>('sessions')
  interface AutoInstance {
    name: string; dir: string; running: boolean; current: string;
    keeps: number; reverts: number; crashes: number; skips: number; iterations: number;
    last: { timestamp: string; status: string; description: string } | null;
    mainChat: string | null;
  }
  interface WorkerSession { id: string; agent: string; mtime: string }
  const [autoInstances, setAutoInstances] = createSignal<AutoInstance[]>([])
  const [currentAuto, setCurrentAuto] = createSignal<string | null>(null)
  const [autoDetail, setAutoDetail] = createSignal<(AutoInstance & { program?: string; results?: string; workerSessions?: WorkerSession[] }) | null>(null)
  const [autoNewName, setAutoNewName] = createSignal('')
  const [autoNewGoal, setAutoNewGoal] = createSignal('')
  const [autoCreating, setAutoCreating] = createSignal(false)
  const [autoBusy, setAutoBusy] = createSignal<string | null>(null)
  function autoLastTs(i: AutoInstance): number {
    return i.last ? new Date(i.last.timestamp).getTime() : 0
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
        fetchSessions().then(s => setSessions(s)).catch(() => {})
      } catch {}
      setAutoNewName(''); setAutoNewGoal('')
      await loadAutoInstances()
      setCurrentAuto(name)
      setSidebar(false)
    } finally { setAutoCreating(false) }
  }
  const [links, setLinks] = createSignal<QuickLink[]>([])
  const [starred, setStarred] = createSignal<Record<string, string[]>>({})
  const [expanded, setExpanded] = createSignal(false)
  const [agents, setAgents] = createSignal<AgentInfo[]>([])
  const [agentDropdown, setAgentDropdown] = createSignal(false)
  let cleanupSSE: (() => void) | null = null
  let mediaRecorder: MediaRecorder | null = null
  let audioChunks: Blob[] = []
  let audioContext: AudioContext | null = null
  let mediaStream: MediaStream | null = null
  let recordingTimer: ReturnType<typeof setInterval> | null = null
  let levelTimer: ReturnType<typeof requestAnimationFrame> | null = null
  let analyser: AnalyserNode | null = null
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
    if (!sidebar() && dx > 60) setSidebar(true)
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
  }

  onMount(async () => {
    document.addEventListener('keydown', onGlobalKeyDown)
    setSessions(await fetchSessions())
    fetchAgents().then(setAgents).catch(() => {})
    const base = location.pathname.replace(/\/+$/, '')
    fetch(`${base}/api/quick-links`).then(r => r.json()).then(setLinks).catch(() => {})
    fetchStarred().then(setStarred).catch(() => {})
    const hash = location.hash.slice(1)
    if (hash) select(hash)
    // Refresh session list when tab becomes visible
    document.addEventListener('visibilitychange', onVisibility)
    // Prefetch Terminal chunk during idle so the tab click feels instant
    const idle = (window as any).requestIdleCallback || ((cb: () => void) => setTimeout(cb, 2000))
    idle(() => { import('./components/Terminal').catch(() => {}) })
  })
  function onVisibility() {
    if (document.visibilityState === 'visible') fetchSessions().then(s => setSessions(s)).catch(() => {})
  }
  onCleanup(() => { cleanupSSE?.(); document.removeEventListener('keydown', onGlobalKeyDown); document.removeEventListener('visibilitychange', onVisibility) })

  async function select(id: string) {
    const prev = currentId()
    if (prev) saveDraft(prev, text())
    setCurrentAuto(null)
    setCurrentId(id)
    location.hash = id
    setSidebar(false)
    setLoading(true)
    setMessages([])
    setWorking(false)
    setText(loadDraft(id))
    setHistoryIdx(-1)
    setHistoryOpen(false)
    cleanupSSE?.()
    try {
      const result = await fetchMessages(id)
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
    }, setSSEStatus)
  }

  async function handleNew(agent?: string) {
    setCreating(true)
    setAgentDropdown(false)
    try {
      const id = await createSession(undefined, agent)
      select(id)
      fetchSessions().then(s => setSessions(s)).catch(() => {})
    } catch (e) { console.error(e) }
    finally { setCreating(false) }
  }

  async function handleResume(id: string) {
    await resumeSession(id)
    setSessions(await fetchSessions())
    select(id)
  }

  async function handleInterrupt(id: string) {
    await interruptSession(id)
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this session?')) return
    setMenuOpen(false)
    await deleteSession(id)
    setCurrentId(null)
    location.hash = ''
    cleanupSSE?.()
    setMessages([])
    setSessions(await fetchSessions())
  }

  async function handleRename(id: string) {
    const title = renameText().trim()
    if (!title) { setRenaming(false); return }
    await renameSession(id, title)
    setRenaming(false)
    setMenuOpen(false)
    setSessions(await fetchSessions())
  }

  async function handleSidebarRename(id: string) {
    const title = sidebarRenameText().trim()
    if (!title) { setSidebarRenaming(null); return }
    await renameSession(id, title)
    setSidebarRenaming(null)
    setSessions(await fetchSessions())
  }

  async function loadEarlier() {
    const id = currentId()
    if (!id || loadingMore()) return
    setLoadingMore(true)
    try {
      const result = await fetchMessages(id, messages().length)
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



  function stopVoice() {
    setListening(false)
    setRecordingTime(0)
    setAudioLevel(0)
    setInterimText('')
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
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop()
      } else {
        stopVoice()
      }
      return
    }

    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch { return }

    audioChunks = []
    setListening(true)
    setRecordingTime(0)

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
      const wasListening = listening()
      stopVoice()
      if (blob.size < 1000) return // too short, ignore

      setTranscribing(true)
      try {
        const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob })
        const data = await res.json()
        if (data.transcript) {
          const prev = text().trim()
          setText(prev ? prev + ' ' + data.transcript : data.transcript)
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

  async function handleSend() {
    const val = text().trim()
    const pending = files()
    if ((!val && !pending.length) || !currentId()) return
    setUploading(true)
    setText('')
    setFiles([])
    if (textareaRef) textareaRef.style.height = 'auto'

    const parts: string[] = val ? [val] : []
    for (const f of pending) {
      try {
        const uploadPath = await uploadFile(f.blob, f.name)
        parts.push(f.isImage ? `[Attached image: ${uploadPath}]` : `[Attached file: ${uploadPath}] (${f.name})`)
      } catch { parts.push(`[Upload failed: ${f.name}]`) }
    }
    const fullText = parts.join('\n')
    pushHistory(fullText)
    saveDraft(currentId()!, '')

    const tempId = `optimistic-${Date.now()}`
    setMessages(prev => [...prev, {
      uuid: tempId, role: 'user', timestamp: new Date().toISOString(),
      content: [{ type: 'text', text: fullText }], delivery: 'sent',
    }])
    sendInput(currentId()!, fullText)
    setUploading(false)
    setWorking(true)
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
    const name = currentAuto()
    if (!name) { setAutoDetail(null); return }
    loadAutoDetail(name)
    const id = setInterval(() => loadAutoDetail(name), 4000)
    onCleanup(() => clearInterval(id))
  })

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
        <button onClick={() => setSidebar(true)} style={{ position: 'fixed', top: 'max(12px, env(safe-area-inset-top))', left: 'max(12px, env(safe-area-inset-left))', 'z-index': '50', background: '#1a1a2e', border: '1px solid #333', color: '#e5e5e5', width: '36px', height: '36px', 'border-radius': '8px', 'font-size': '18px', cursor: 'pointer', display: 'flex', 'align-items': 'center', 'justify-content': 'center', '-webkit-tap-highlight-color': 'transparent' }}>&#9776;</button>
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
            <button onClick={() => setSidebarTab('auto')} style={{ flex: '1', padding: '8px', border: 'none', 'border-bottom': sidebarTab() === 'auto' ? '2px solid #4aba6a' : '2px solid transparent', background: 'none', color: sidebarTab() === 'auto' ? '#e5e5e5' : '#666', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Auto</button>
            <button onClick={() => setSidebarTab('links')} style={{ flex: '1', padding: '8px', border: 'none', 'border-bottom': sidebarTab() === 'links' ? '2px solid #4aba6a' : '2px solid transparent', background: 'none', color: sidebarTab() === 'links' ? '#e5e5e5' : '#666', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Links</button>
          </div>
          {/* Sessions tab */}
          <Show when={sidebarTab() === 'sessions'}>
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
            <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', 'padding-bottom': 'env(safe-area-inset-bottom)' }}>
              {(() => {
                const all = sessions().filter(s => !s.isWorker)
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
                      onDblClick={(e) => { e.preventDefault(); setSidebarRenameText(s.title); setSidebarRenaming(s.id) }}
                      onContextMenu={(e) => { e.preventDefault(); setSidebarRenameText(s.title); setSidebarRenaming(s.id) }}
                      style={{ padding: '10px 16px', cursor: 'pointer', 'border-left': s.id === currentId() ? '3px solid #4aba6a' : '3px solid transparent', background: s.id === currentId() ? '#1a1a2e' : 'transparent', 'border-bottom': '1px solid #111', '-webkit-tap-highlight-color': 'transparent' }}>
                      <Show when={sidebarRenaming() === s.id} fallback={
                        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                          <Show when={s.isActive}><span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>
                          <span style={{ 'font-size': '13px', 'font-weight': '500', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }}>{s.title}</span>
                          <Show when={s.agent === 'omp'}><span style={{ 'font-size': '9px', padding: '1px 5px', 'border-radius': '3px', background: '#3a2200', color: '#ff7b00', 'flex-shrink': '0', 'font-weight': '600' }}>omp</span></Show>
                          <Show when={s.agent === 'codex'}><span style={{ 'font-size': '9px', padding: '1px 5px', 'border-radius': '3px', background: '#2a1e3a', color: '#c084fc', 'flex-shrink': '0', 'font-weight': '600' }}>codex</span></Show>
                          <span style={{ 'font-size': '11px', color: '#555', 'flex-shrink': '0' }}>{timeAgo(s.updatedAt)}</span>
                        </div>
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
                <div onClick={() => { setCurrentAuto(inst.name); setSidebar(false) }}
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
        <Show when={!currentAuto()}>
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
              <Show when={s().isActive}>
                <button onClick={() => handleInterrupt(s().id)} style={{ background: '#d45555', color: '#fff', border: 'none', 'border-radius': '6px', padding: '4px 12px', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Stop</button>
              </Show>
              <Show when={!s().isActive}>
                <button onClick={() => handleResume(s().id)} style={{ background: '#4aba6a', color: '#000', border: 'none', 'border-radius': '6px', padding: '4px 12px', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Resume</button>
              </Show>
              <div style={{ position: 'relative' }}>
                <button onClick={() => setMenuOpen(!menuOpen())} style={{ background: 'none', border: 'none', color: '#888', 'font-size': '18px', cursor: 'pointer', padding: '4px 6px', '-webkit-tap-highlight-color': 'transparent' }}>{'\u22EE'}</button>
                <Show when={menuOpen()}>
                  <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: '0', 'z-index': '99' }} />
                  <div style={{ position: 'absolute', right: '0', top: '100%', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '8px', 'box-shadow': '0 4px 12px rgba(0,0,0,0.5)', 'z-index': '100', 'min-width': '140px', overflow: 'hidden' }}>
                    <button onClick={() => { setRenameText(s().title); setRenaming(true); setMenuOpen(false) }}
                      style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Rename</button>
                    <a href={exportUrl(s().id)} download style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer', 'text-decoration': 'none' }} onClick={() => setMenuOpen(false)}>Export MD</a>
                    <button onClick={() => handleDelete(s().id)}
                      style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', color: '#d45555', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Delete</button>
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
            <button onClick={() => setTab('files')} style={tabStyle('files')}>Files{touchedFiles().length > 0 ? ` (${touchedFiles().length})` : ''}</button>
            <button onClick={() => setTab('terminal')} style={tabStyle('terminal')}>Terminal</button>
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
              <MessageView messages={messages()} loading={loading()} hasMore={hasMore()} loadingMore={loadingMore()} onLoadEarlier={loadEarlier} onAnswer={(t) => { if (currentId()) sendInput(currentId()!, t) }} starred={new Set(starred()[currentId()!] || [])} onToggleStar={(uuid) => { if (currentId()) toggleStar(currentId()!, uuid) }} working={working()} />
            </div>
            <div style={{ display: tab() === 'files' ? 'block' : 'none', height: '100%', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', padding: '8px 0' }}>
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
            const isMd = v.path.toLowerCase().endsWith('.md')
            return (
              <div onClick={() => setViewingFile(null)} style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.6)', 'z-index': '200', display: 'flex', 'align-items': 'stretch', 'justify-content': 'center', padding: 'max(20px, env(safe-area-inset-top)) 16px max(20px, env(safe-area-inset-bottom))' }}>
                <div onClick={(e) => e.stopPropagation()} style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '12px', 'max-width': '900px', width: '100%', display: 'flex', 'flex-direction': 'column', 'overflow': 'hidden' }}>
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '10px 14px', 'border-bottom': '1px solid #1e1e1e', background: '#0a0e14', 'flex-shrink': '0' }}>
                    <span style={{ color: '#888', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace", overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }} title={v.path}>{v.path}</span>
                    <button onClick={() => openInEditor(v.path)} style={{ background: 'transparent', border: '1px solid #333', color: '#888', 'font-size': '11px', padding: '3px 8px', 'border-radius': '6px', cursor: 'pointer' }}>Open</button>
                    <button onClick={() => setViewingFile(null)} style={{ background: 'transparent', border: 'none', color: '#888', 'font-size': '20px', cursor: 'pointer', padding: '0 4px', 'line-height': '1' }}>&times;</button>
                  </div>
                  <div style={{ 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', flex: '1' }}>
                    <Show when={v.error}>
                      <div style={{ padding: '20px', color: '#c44', 'font-size': '13px' }}>{v.error}</div>
                    </Show>
                    <Show when={!v.error && !v.content}>
                      <div style={{ padding: '20px', color: '#666', 'font-size': '13px' }}>Loading…</div>
                    </Show>
                    <Show when={!v.error && v.content && isMd}>
                      <div class="prose" style={{ padding: '4px 24px', color: '#d0d0d0', 'font-size': '14px', 'line-height': '1.55' }} innerHTML={marked.parse(v.content) as string} />
                    </Show>
                    <Show when={!v.error && v.content && !isMd}>
                      <pre style={{ margin: '0', padding: '16px 20px', color: '#d0d0d0', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace", 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{v.content}</pre>
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

        {/* Input (chat tab only) */}
        <Show when={currentId() && tab() === 'chat'}>
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
              <button onClick={toggleVoice} disabled={transcribing()} style={{ background: listening() ? `rgba(212, 85, 85, ${0.15 + audioLevel() * 0.35})` : 'none', border: listening() ? '1px solid #d45555' : 'none', 'border-radius': '8px', color: transcribing() ? '#c9a227' : listening() ? '#d45555' : '#666', 'font-size': '16px', cursor: transcribing() ? 'wait' : 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px', transition: 'all 0.15s' }} title={transcribing() ? 'Transcribing...' : listening() ? 'Stop & transcribe' : 'Record voice memo'}>{transcribing() ? '\u23F3' : listening() ? '\u23F9' : '\uD83C\uDF99'}</button>
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
              placeholder={transcribing() ? 'Transcribing...' : listening() ? `Recording ${Math.floor(recordingTime() / 60)}:${(recordingTime() % 60).toString().padStart(2, '0')}` : "Send a message..."} rows={expanded() ? undefined : 1}
              style={{ flex: expanded() ? '1' : undefined, width: expanded() ? '100%' : undefined, 'flex-grow': expanded() ? '1' : undefined, background: '#1a1a2e', border: expanded() ? 'none' : '1px solid #333', 'border-radius': expanded() ? '0' : '12px', padding: expanded() ? '14px 16px' : '10px 14px', color: '#e5e5e5', 'font-size': expanded() ? '18px' : '16px', 'font-family': 'inherit', resize: 'none', outline: 'none', 'line-height': '1.5', 'max-height': expanded() ? 'none' : '120px', '-webkit-appearance': 'none', ...(listening() ? { '::placeholder': { color: '#73b8ff' } } : {}), ...(expanded() ? { 'min-height': '0', 'overflow-y': 'auto' } : { flex: '1' }) }} />
            <div style={{ display: 'flex', gap: '8px', 'align-items': 'center', padding: expanded() ? '8px 12px' : '0', 'padding-bottom': expanded() ? 'max(8px, env(safe-area-inset-bottom))' : '0', background: expanded() ? '#0a0e14' : 'transparent', 'border-top': expanded() ? '1px solid #1e1e1e' : 'none', 'justify-content': expanded() ? 'space-between' : 'flex-start' }}>
              <Show when={expanded()}>
                <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                  <button onClick={() => fileInputRef?.click()} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '20px', cursor: 'pointer', padding: '8px 4px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '32px', 'min-height': '42px' }} title="Attach file">+</button>
                  <button onClick={() => setHistoryOpen(!historyOpen())} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '16px', cursor: 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px' }} title="Message history">{'\u2191'}</button>
                  <button onClick={toggleVoice} disabled={transcribing()} style={{ background: listening() ? `rgba(212, 85, 85, ${0.15 + audioLevel() * 0.35})` : 'none', border: listening() ? '1px solid #d45555' : 'none', 'border-radius': '8px', color: transcribing() ? '#c9a227' : listening() ? '#d45555' : '#666', 'font-size': '16px', cursor: transcribing() ? 'wait' : 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px', transition: 'all 0.15s' }} title={transcribing() ? 'Transcribing...' : listening() ? 'Stop & transcribe' : 'Record voice memo'}>{transcribing() ? '\u23F3' : listening() ? '\u23F9' : '\uD83C\uDF99'}</button>
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
