declare const __BUILD_TIME__: string
import { createSignal, createEffect, onMount, onCleanup, Show, For } from 'solid-js'
import { MessageView } from './components/MessageView'
import { Terminal } from './components/Terminal'
import type { SessionMeta, Message, Project } from './api'
import { fetchSessions, fetchMessages, subscribeMessages, sendInput, createSession, resumeSession, interruptSession, uploadFile, deleteSession, renameSession, forkSession, fetchStarred, saveStarred, exportUrl, openInEditor, fetchProjects, checkAuth, login, logout } from './api'

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
  const [authUser, setAuthUser] = createSignal<{ username: string; admin: boolean } | null>(null)
  const [authChecked, setAuthChecked] = createSignal(false)
  const [loginError, setLoginError] = createSignal('')
  const [loginLoading, setLoginLoading] = createSignal(false)

  const [sessions, setSessions] = createSignal<SessionMeta[]>([])
  const [currentId, setCurrentId] = createSignal<string | null>(null)
  const [messages, setMessages] = createSignal<Message[]>([])
  const [sidebar, setSidebar] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [text, setText] = createSignal('')
  const [tab, setTab] = createSignal<'chat' | 'files' | 'terminal'>('chat')
  const [files, setFiles] = createSignal<PendingFile[]>([])
  const [uploading, setUploading] = createSignal(false)
  const [working, setWorking] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [historyIdx, setHistoryIdx] = createSignal(-1)
  const [historyOpen, setHistoryOpen] = createSignal(false)
  const [sseStatus, setSSEStatus] = createSignal<'connected' | 'reconnecting'>('connected')
  const [listening, setListening] = createSignal(false)
  const [hasMore, setHasMore] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [renaming, setRenaming] = createSignal(false)
  const [renameText, setRenameText] = createSignal('')
  const [sidebarRenaming, setSidebarRenaming] = createSignal<string | null>(null)
  const [sidebarRenameText, setSidebarRenameText] = createSignal('')
  const [sidebarTab, setSidebarTab] = createSignal<'sessions' | 'links'>('sessions')
  const [showChangelog, setShowChangelog] = createSignal(false)
  const [projectsExpanded, setProjectsExpanded] = createSignal(false)
  const [links, setLinks] = createSignal<QuickLink[]>([])
  const [starred, setStarred] = createSignal<Record<string, string[]>>({})
  const [projects, setProjects] = createSignal<Project[]>([])
  const [currentProject, setCurrentProject] = createSignal<string | null>(localStorage.getItem('feather-next-project'))
  const [expandedGroups, setExpandedGroups] = createSignal<Record<string, boolean>>(JSON.parse(localStorage.getItem('feather-next-groups') || '{}'))
  let cleanupSSE: (() => void) | null = null
  let recognition: any = null
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

  async function initApp() {
    document.addEventListener('keydown', onGlobalKeyDown)
    setSessions(await fetchSessions())
    fetchProjects().then(setProjects).catch(() => {})
    const base = location.pathname.replace(/\/+$/, '')
    fetch(`${base}/api/quick-links`).then(r => r.ok ? r.json() : []).then(setLinks).catch(() => {})
    fetchStarred().then(setStarred).catch(() => {})
    const hash = location.hash.slice(1)
    if (hash) select(hash)
  }

  onMount(async () => {
    const user = await checkAuth()
    setAuthChecked(true)
    if (user) {
      setAuthUser(user)
      await initApp()
    }
  })
  const pollTimer = setInterval(async () => {
    try { setSessions(await fetchSessions()) } catch {}
  }, 10000)
  onCleanup(() => { clearInterval(pollTimer); cleanupSSE?.(); document.removeEventListener('keydown', onGlobalKeyDown) })

  async function select(id: string) {
    const prev = currentId()
    if (prev) saveDraft(prev, text())
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

  async function handleNew() {
    setCreating(true)
    try {
      const id = await createSession()
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

  async function handleFork(id: string) {
    setMenuOpen(false)
    await forkSession(id)
    setTimeout(async () => { setSessions(await fetchSessions()) }, 3000)
  }

  function toggleVoice() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return
    if (listening()) { recognition?.stop(); setListening(false); return }
    recognition = new SR()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = 'en-US'
    recognition.onresult = (e: any) => {
      let t = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) t += e.results[i][0].transcript
      }
      if (t) setText(prev => prev + (prev ? ' ' : '') + t)
    }
    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)
    recognition.start()
    setListening(true)
  }

  async function handleSend() {
    const val = text().trim()
    const pending = files()
    if (!val && !pending.length) return
    // Auto-create session if none selected
    if (!currentId()) {
      try {
        const id = await createSession()
        setSessions(await fetchSessions())
        select(id)
        // Wait a tick for the SSE to connect
        await new Promise(r => setTimeout(r, 500))
      } catch { return }
    }
    if (!currentId()) return
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

  async function handleLogin(e: Event) {
    e.preventDefault()
    setLoginLoading(true)
    setLoginError('')
    const form = e.target as HTMLFormElement
    const username = (form.querySelector('[name=username]') as HTMLInputElement).value
    const password = (form.querySelector('[name=password]') as HTMLInputElement).value
    try {
      const result = await login(username, password)
      if (result.ok) {
        const user = await checkAuth()
        if (user) {
          setAuthUser(user)
          await initApp()
        }
      } else {
        setLoginError(result.error || 'Login failed')
      }
    } catch {
      setLoginError('Connection error')
    }
    setLoginLoading(false)
  }

  async function handleLogout() {
    await logout()
    setAuthUser(null)
    setSessions([])
    setCurrentId(null)
    setMessages([])
  }

  // Login screen component
  const LoginScreen = () => (
    <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'center', height: 'calc(var(--vh, 1vh) * 100)', background: '#0a0e14', 'font-family': "-apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif", padding: '20px' }}>
      <form onSubmit={handleLogin} action="/api/login" method="POST" style={{ width: '100%', 'max-width': '320px', background: '#0d1117', border: '1px solid #1e1e1e', 'border-radius': '16px', padding: '32px 24px', 'text-align': 'center' }}>
        <div style={{ 'font-size': '40px', 'margin-bottom': '8px' }}>&#x1fab6;</div>
        <h1 style={{ 'font-size': '20px', 'font-weight': '700', color: '#e5e5e5', 'margin-bottom': '24px' }}>Feather</h1>
        <label for="username" style={{ display: 'none' }}>Username</label>
        <input id="username" name="username" type="text" placeholder="Username" autocomplete="username" autofocus
          style={{ width: '100%', padding: '12px 16px', background: '#161b22', border: '1px solid #333', 'border-radius': '8px', color: '#e5e5e5', 'font-size': '15px', 'margin-bottom': '12px', outline: 'none', 'box-sizing': 'border-box' }} />
        <label for="password" style={{ display: 'none' }}>Password</label>
        <input id="password" name="password" type="password" placeholder="Password" autocomplete="current-password"
          style={{ width: '100%', padding: '12px 16px', background: '#161b22', border: '1px solid #333', 'border-radius': '8px', color: '#e5e5e5', 'font-size': '15px', 'margin-bottom': '16px', outline: 'none', 'box-sizing': 'border-box' }} />
        <Show when={loginError()}>
          <div style={{ color: '#d45555', 'font-size': '13px', 'margin-bottom': '12px' }}>{loginError()}</div>
        </Show>
        <button type="submit" disabled={loginLoading()}
          style={{ width: '100%', padding: '12px', background: loginLoading() ? '#1a1a2e' : '#4aba6a', color: loginLoading() ? '#666' : '#000', border: 'none', 'border-radius': '8px', 'font-size': '15px', 'font-weight': '600', cursor: loginLoading() ? 'wait' : 'pointer' }}>
          {loginLoading() ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  )

  return (
    <Show when={authChecked()} fallback={<div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'center', height: '100vh', background: '#0a0e14', color: '#555', 'font-family': "-apple-system, system-ui, sans-serif" }}>Loading...</div>}>
    <Show when={authUser()} fallback={<LoginScreen />}>
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
        <div onClick={() => setSidebar(false)} style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.5)', 'z-index': '59', '-webkit-tap-highlight-color': 'transparent' }} />
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
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
              <span style={{ 'font-size': '12px', color: '#4aba6a', 'font-weight': '500' }}>{authUser()?.username}</span>
              <button onClick={handleLogout} style={{ background: 'none', border: '1px solid #333', color: '#888', 'font-size': '11px', padding: '2px 8px', 'border-radius': '4px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Logout</button>
              <button onClick={() => setSidebar(false)} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '20px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent', padding: '4px 8px' }}>&times;</button>
            </div>
          </div>
          {/* Sidebar tabs */}
          <div style={{ display: 'flex', 'border-bottom': '1px solid #1e1e1e' }}>
            <button onClick={() => setSidebarTab('sessions')} style={{ flex: '1', padding: '8px', border: 'none', 'border-bottom': sidebarTab() === 'sessions' ? '2px solid #4aba6a' : '2px solid transparent', background: 'none', color: sidebarTab() === 'sessions' ? '#e5e5e5' : '#666', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Sessions</button>
            <button onClick={() => setSidebarTab('links')} style={{ flex: '1', padding: '8px', border: 'none', 'border-bottom': sidebarTab() === 'links' ? '2px solid #4aba6a' : '2px solid transparent', background: 'none', color: sidebarTab() === 'links' ? '#e5e5e5' : '#666', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Links</button>
          </div>
          {/* Sessions tab */}
          <Show when={sidebarTab() === 'sessions'}>
            {/* Project tree (collapsed by default, click to expand) */}
            <div style={{ 'border-bottom': '1px solid #1e1e1e', padding: '4px 0' }}>
              <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', padding: '4px 16px' }}>
                <div onClick={() => setProjectsExpanded(!projectsExpanded())}
                  style={{ cursor: 'pointer', 'font-size': '11px', 'font-weight': '600', color: '#777', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', '-webkit-tap-highlight-color': 'transparent', display: 'flex', 'align-items': 'center', gap: '4px' }}>
                  <span style={{ 'font-size': '8px', transition: 'transform 0.15s', transform: projectsExpanded() ? 'rotate(90deg)' : 'none' }}>&#9654;</span>
                  Projects
                </div>
                <Show when={currentProject()}>
                  <span style={{ 'font-size': '11px', color: '#4aba6a', 'font-weight': '600' }}>{projects().find(p => p.id === currentProject())?.label || ''}</span>
                  <span onClick={(e) => { e.stopPropagation(); setCurrentProject(null); localStorage.removeItem('feather-next-project') }}
                    style={{ 'font-size': '10px', color: '#666', cursor: 'pointer', padding: '0 4px' }}>&times;</span>
                </Show>
              </div>
              <Show when={projectsExpanded()}>
              <div style={{ 'max-height': '35vh', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch' }}>
              {/* All projects button */}
              <div onClick={() => { setCurrentProject(null); localStorage.removeItem('feather-next-project'); setProjectsExpanded(false) }}
                style={{ padding: '4px 16px', cursor: 'pointer', 'font-size': '11px', 'font-weight': '600', color: currentProject() === null ? '#4aba6a' : '#888', '-webkit-tap-highlight-color': 'transparent' }}>
                All
              </div>
              {/* Grouped projects */}
              {(() => {
                const projs = projects()
                const grouped: Record<string, Project[]> = {}
                const ungrouped: Project[] = []
                projs.forEach(p => {
                  const idx = p.label.indexOf(' / ')
                  if (idx >= 0) {
                    const g = p.label.substring(0, idx)
                    if (!grouped[g]) grouped[g] = []
                    grouped[g].push({ ...p, label: p.label.substring(idx + 3) })
                  } else {
                    ungrouped.push(p)
                  }
                })
                const groups = Object.keys(grouped).sort()
                return <>
                  <For each={groups}>{(group) => {
                    const isOpen = () => expandedGroups()[group]
                    const toggle = () => {
                      const next = { ...expandedGroups(), [group]: !isOpen() }
                      setExpandedGroups(next)
                      localStorage.setItem('feather-next-groups', JSON.stringify(next))
                    }
                    return <>
                      <div onClick={toggle} style={{ padding: '4px 16px', cursor: 'pointer', display: 'flex', 'align-items': 'center', gap: '4px', 'font-size': '11px', 'font-weight': '600', color: '#777', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', '-webkit-tap-highlight-color': 'transparent' }}>
                        <span style={{ 'font-size': '8px', transition: 'transform 0.15s', transform: isOpen() ? 'rotate(90deg)' : 'none' }}>&#9654;</span>
                        {group}
                      </div>
                      <Show when={isOpen()}>
                        <For each={grouped[group]}>{(p) => (
                          <div onClick={() => { setCurrentProject(p.id); localStorage.setItem('feather-next-project', p.id) }}
                            style={{ padding: '3px 16px 3px 28px', cursor: 'pointer', 'font-size': '12px', color: currentProject() === p.id ? '#4aba6a' : '#aaa', 'font-weight': currentProject() === p.id ? '600' : '400', '-webkit-tap-highlight-color': 'transparent' }}>
                            {p.label}
                          </div>
                        )}</For>
                      </Show>
                    </>
                  }}</For>
                  <For each={ungrouped}>{(p) => (
                    <div onClick={() => { setCurrentProject(p.id); localStorage.setItem('feather-next-project', p.id) }}
                      style={{ padding: '3px 16px', cursor: 'pointer', 'font-size': '12px', color: currentProject() === p.id ? '#4aba6a' : '#aaa', 'font-weight': currentProject() === p.id ? '600' : '400', '-webkit-tap-highlight-color': 'transparent' }}>
                      {p.label}
                    </div>
                  )}</For>
                </>
              })()}
              </div>
              </Show>
            </div>
            {/* New session button */}
            <div style={{ padding: '8px 16px' }}>
              <button onClick={handleNew} disabled={creating()} style={{ width: '100%', padding: '10px', background: creating() ? '#1a1a2e' : '#4aba6a', color: creating() ? '#666' : '#000', border: 'none', 'border-radius': '8px', 'font-size': '14px', 'font-weight': '600', cursor: creating() ? 'wait' : 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
                {creating() ? 'Starting...' : '+ New Claude'}
              </button>
            </div>
            {/* Session list (filtered by project, grouped by time) */}
            <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', 'padding-bottom': 'env(safe-area-inset-bottom)' }}>
              {(() => {
                const filtered = sessions().filter(s => !currentProject() || s.projectId === currentProject())
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
                for (const s of filtered) {
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
                          <div style={{ flex: '1', 'min-width': '0' }}>
                            <div style={{ 'font-size': '13px', 'font-weight': '500', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{s.title}</div>
                            <Show when={!currentProject() && s.projectLabel}>
                              <div style={{ 'font-size': '10px', color: '#444', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{s.projectLabel}</div>
                            </Show>
                          </div>
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
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-width': '0', height: '100%' }}>
        {/* Header */}
        <div style={{ padding: '8px 16px 0 56px', 'padding-top': 'max(8px, env(safe-area-inset-top))', 'border-bottom': '1px solid #1e1e1e', display: 'flex', 'align-items': 'center', gap: '8px', 'min-height': '48px', 'flex-shrink': '0' }}>
          <Show when={cur()} fallback={<span style={{ color: '#666', 'font-size': '14px' }}>Select a session</span>}>
            {(s) => <>
              <Show when={s().isActive}><span style={{ width: '8px', height: '8px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>
              <Show when={renaming()} fallback={
                <div style={{ overflow: 'hidden', 'min-width': '0' }}>
                  <Show when={s().projectLabel || (s().projectId && projects().find(p => p.id === s().projectId)?.label)}>
                    {(label) => <div style={{ 'font-size': '10px', color: '#666', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{label()}</div>}
                  </Show>
                  <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'font-size': '14px', 'font-weight': '600', display: 'block' }}>{s().title}</span>
                </div>
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
              <Show when={!s().isActive}>
                <button onClick={() => handleResume(s().id)} style={{ background: '#4aba6a', color: '#000', border: 'none', 'border-radius': '6px', padding: '4px 12px', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>Resume</button>
              </Show>
              <div style={{ position: 'relative' }}>
                <button onClick={() => setMenuOpen(!menuOpen())} style={{ background: 'none', border: 'none', color: '#888', 'font-size': '18px', cursor: 'pointer', padding: '4px 6px', '-webkit-tap-highlight-color': 'transparent' }}>{'\u22EE'}</button>
                <Show when={menuOpen()}>
                  <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: '0', 'z-index': '99' }} />
                  <div style={{ position: 'absolute', right: '0', top: '100%', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '8px', 'box-shadow': '0 4px 12px rgba(0,0,0,0.5)', 'z-index': '100', 'min-width': '140px', overflow: 'hidden' }}>
                    <Show when={s().isActive}>
                      <button onClick={() => { handleInterrupt(s().id); setMenuOpen(false) }}
                        style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#d45555', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Stop</button>
                    </Show>
                    <button onClick={() => { setRenameText(s().title); setRenaming(true); setMenuOpen(false) }}
                      style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Rename</button>
                    <button onClick={() => handleFork(s().id)}
                      style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#e5e5e5', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer' }}>Fork</button>
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
            <span onClick={() => setShowChangelog(!showChangelog())} style={{ 'margin-left': 'auto', 'padding-right': '12px', 'font-size': '10px', color: '#444', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>{__BUILD_TIME__}</span>
          </div>
        </Show>

        {/* What's New popover */}
        <Show when={showChangelog()}>
          <div onClick={() => setShowChangelog(false)} style={{ position: 'fixed', inset: '0', 'z-index': '150' }} />
          <div style={{ position: 'absolute', right: '12px', top: '100px', width: '320px', 'max-width': '85vw', 'max-height': '60vh', 'overflow-y': 'auto', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '12px', 'box-shadow': '0 8px 24px rgba(0,0,0,0.6)', 'z-index': '151', padding: '16px' }}>
            <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'margin-bottom': '12px' }}>
              <span style={{ 'font-size': '14px', 'font-weight': '700', color: '#e5e5e5' }}>What's New</span>
              <button onClick={() => setShowChangelog(false)} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '16px', cursor: 'pointer' }}>&times;</button>
            </div>
            <div style={{ 'font-size': '12px', color: '#aaa', 'line-height': '1.6' }}>
              <div style={{ color: '#4aba6a', 'font-weight': '600', 'margin-bottom': '6px' }}>March 28, 2026</div>
              <ul style={{ margin: '0', padding: '0 0 0 16px' }}>
                <li>Typing indicator (bouncing dots while Claude works)</li>
                <li>Session time grouping (Today / Yesterday / This Week)</li>
                <li>Expandable tool cards (Agent, Grep, Read details)</li>
                <li>Tool results collapse with line count</li>
                <li>Project labels in header and sidebar</li>
                <li>Sidebar rename (double-click or long-press)</li>
                <li>Stop button moved to menu</li>
                <li>Image and file preview in messages</li>
                <li>Scroll-to-bottom button</li>
                <li>Auto-resume reaped sessions</li>
                <li>Collapsible project tree</li>
                <li>ANSI stripping, URL links open in new tab</li>
                <li>Session persistence across restarts</li>
              </ul>
            </div>
          </div>
        </Show>

        {/* Reconnecting banner */}
        <Show when={sseStatus() === 'reconnecting' && currentId()}>
          <div style={{ padding: '4px 16px', background: '#c4993a', color: '#000', 'font-size': '12px', 'font-weight': '600', 'text-align': 'center', 'flex-shrink': '0' }}>Reconnecting...</div>
        </Show>

        {/* Content */}
        <div style={{ flex: '1', overflow: 'hidden' }}>
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
                  <div style={{ padding: '8px 16px', 'border-bottom': '1px solid #111', 'font-size': '13px' }}>
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
              <Terminal sessionId={tab() === 'terminal' ? currentId() : null} />
            </div>
          </Show>
        </div>

        {/* Drag overlay */}
        <Show when={dragging()}>
          <div style={{ position: 'absolute', inset: '0', background: 'rgba(74,186,106,0.1)', border: '2px dashed #4aba6a', 'border-radius': '12px', 'z-index': '100', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'pointer-events': 'none' }}>
            <span style={{ color: '#4aba6a', 'font-size': '18px', 'font-weight': '600' }}>Drop files to attach</span>
          </div>
        </Show>

        {/* Input (chat tab only) */}
        <Show when={tab() === 'chat' || !currentId()}>
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
          <div style={{ padding: '8px 12px', 'padding-bottom': 'max(8px, env(safe-area-inset-bottom))', 'border-top': files().length ? 'none' : '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', gap: '8px', 'align-items': 'flex-end', 'flex-shrink': '0', position: 'relative' }}>
            <Show when={historyOpen()}>
              <div onClick={() => setHistoryOpen(false)} style={{ position: 'fixed', inset: '0', 'z-index': '49' }} />
              <div style={{ position: 'absolute', bottom: '100%', left: '0', right: '0', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '8px 8px 0 0', 'max-height': '200px', 'overflow-y': 'auto', 'z-index': '50' }}>
                <For each={getHistory().slice().reverse()}>{(item) => (
                  <button onClick={() => { setText(item); setHistoryOpen(false) }}
                    style={{ display: 'block', width: '100%', padding: '8px 12px', background: 'none', border: 'none', 'border-bottom': '1px solid #222', color: '#ccc', 'font-size': '13px', 'text-align': 'left', cursor: 'pointer', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{item}</button>
                )}</For>
              </div>
            </Show>
            <button onClick={() => fileInputRef?.click()} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '20px', cursor: 'pointer', padding: '8px 4px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '32px', 'min-height': '42px' }} title="Attach file">+</button>
            <button onClick={() => setHistoryOpen(!historyOpen())} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '16px', cursor: 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px' }} title="Message history">{'\u2191'}</button>
            <button onClick={toggleVoice} style={{ background: 'none', border: 'none', color: listening() ? '#d45555' : '#666', 'font-size': '16px', cursor: 'pointer', padding: '8px 2px', 'line-height': '1', '-webkit-tap-highlight-color': 'transparent', 'min-width': '24px', 'min-height': '42px', transition: 'color 0.15s' }} title="Voice input">{'\uD83C\uDF99'}</button>
            <textarea ref={textareaRef} value={text()}
              onInput={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
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
              placeholder="Send a message..." rows={1}
              style={{ flex: '1', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '12px', padding: '10px 14px', color: '#e5e5e5', 'font-size': '16px', 'font-family': 'inherit', resize: 'none', outline: 'none', 'line-height': '1.4', 'max-height': '120px', '-webkit-appearance': 'none' }} />
            <button onClick={handleSend} disabled={uploading()} style={{ background: (text().trim() || files().length) ? '#4aba6a' : '#333', color: (text().trim() || files().length) ? '#000' : '#666', border: 'none', 'border-radius': '12px', padding: '10px 16px', 'font-size': '15px', 'font-weight': '600', cursor: (text().trim() || files().length) ? 'pointer' : 'default', 'min-height': '42px', '-webkit-tap-highlight-color': 'transparent' }}>{uploading() ? '...' : 'Send'}</button>
          </div>
        </Show>
      </div>
    </div>
    </Show>
    </Show>
  )
}
