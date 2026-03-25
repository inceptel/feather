import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { MessageView } from './components/MessageView'
import { Terminal } from './components/Terminal'
import type { SessionMeta, Message } from './api'
import { fetchSessions, fetchMessages, subscribeMessages, sendInput, createSession, resumeSession, uploadFile } from './api'

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

export default function App() {
  const [sessions, setSessions] = createSignal<SessionMeta[]>([])
  const [currentId, setCurrentId] = createSignal<string | null>(null)
  const [messages, setMessages] = createSignal<Message[]>([])
  const [sidebar, setSidebar] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [text, setText] = createSignal('')
  const [tab, setTab] = createSignal<'chat' | 'terminal'>('chat')
  const [files, setFiles] = createSignal<PendingFile[]>([])
  const [uploading, setUploading] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  let cleanupSSE: (() => void) | null = null
  let textareaRef: HTMLTextAreaElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let dragCounter = 0

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

  onMount(async () => {
    const nextSessions = await fetchSessions()
    setSessions(nextSessions)
    const hash = location.hash.slice(1)
    const initialSessionId = hash || nextSessions.find(session => session.isActive)?.id
    if (initialSessionId) select(initialSessionId)
  })
  onCleanup(() => cleanupSSE?.())

  async function select(id: string) {
    setCurrentId(id)
    location.hash = id
    setSidebar(false)
    setLoading(true)
    setMessages([])
    cleanupSSE?.()
    try { setMessages(await fetchMessages(id)) } catch {}
    setLoading(false)
    cleanupSSE = subscribeMessages(id, (msg) => {
      setMessages(prev => {
        if (prev.some(m => m.uuid === msg.uuid)) return prev
        // Try to match an optimistic message (same text content, sent within 30s)
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
    })
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

  async function handleSend() {
    const val = text().trim()
    const pending = files()
    if ((!val && !pending.length) || !currentId()) return
    setUploading(true)
    setText('')
    setFiles([])
    if (textareaRef) textareaRef.style.height = 'auto'

    // Upload files, build message text
    const parts: string[] = val ? [val] : []
    for (const f of pending) {
      try {
        const uploadPath = await uploadFile(f.blob, f.name)
        parts.push(f.isImage ? `[Attached image: ${uploadPath}]` : `[Attached file: ${uploadPath}] (${f.name})`)
      } catch { parts.push(`[Upload failed: ${f.name}]`) }
    }
    const fullText = parts.join('\n')

    const tempId = `optimistic-${Date.now()}`
    setMessages(prev => [...prev, {
      uuid: tempId, role: 'user', timestamp: new Date().toISOString(),
      content: [{ type: 'text', text: fullText }], delivery: 'sent',
    }])
    sendInput(currentId()!, fullText)
    setUploading(false)
  }

  const cur = () => sessions().find(s => s.id === currentId())
  const tabStyle = (t: string) => ({
    padding: '0 16px', height: '44px', border: 'none', 'border-bottom': tab() === t ? '2px solid #4aba6a' : '2px solid transparent',
    background: 'none', color: tab() === t ? '#e5e5e5' : '#666', 'font-size': '13px', 'font-weight': '600', cursor: 'pointer',
    display: 'inline-flex', 'align-items': 'center', 'justify-content': 'center',
  })

  return (
    <div
      onDragEnter={(e) => { e.preventDefault(); dragCounter++; setDragging(true) }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; setDragging(false) } }}
      onDrop={(e) => { e.preventDefault(); dragCounter = 0; setDragging(false); if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files) }}
      style={{ display: 'flex', height: 'calc(var(--vh, 1vh) * 100)', width: '100%', 'font-family': "-apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif", position: 'relative' }}>

      {/* Hamburger */}
      <Show when={!sidebar()}>
        <button aria-label="Open session list" onClick={() => setSidebar(true)} style={{ position: 'fixed', top: '12px', left: '12px', 'z-index': '50', background: '#1a1a2e', border: '1px solid #333', color: '#e5e5e5', width: '44px', height: '44px', 'border-radius': '8px', 'font-size': '18px', cursor: 'pointer', display: 'flex', 'align-items': 'center', 'justify-content': 'center' }}>&#9776;</button>
      </Show>

      {/* Sidebar */}
      <div style={{ width: sidebar() ? '300px' : '0', 'min-width': sidebar() ? '300px' : '0', height: '100%', background: '#0d1117', 'border-right': sidebar() ? '1px solid #1e1e1e' : 'none', overflow: 'hidden', transition: 'width 0.2s, min-width 0.2s', 'z-index': '40' }}>
          <div style={{ display: 'flex', 'flex-direction': 'column', height: '100%', visibility: sidebar() ? 'visible' : 'hidden', 'pointer-events': sidebar() ? 'auto' : 'none' }}>
            <div style={{ padding: '12px 16px', display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', 'border-bottom': '1px solid #1e1e1e' }}>
              <span style={{ 'font-weight': '700', 'font-size': '16px' }}>Feather</span>
              <button
                onClick={() => setSidebar(false)}
                aria-label="Close session drawer"
                style={{
                  width: '44px',
                  height: '44px',
                  display: 'flex',
                  'align-items': 'center',
                  'justify-content': 'center',
                  background: 'none',
                  border: 'none',
                  color: '#666',
                  'font-size': '20px',
                  cursor: 'pointer',
                  'border-radius': '8px',
                  'flex-shrink': '0',
                  padding: '0',
                  'line-height': '1',
                }}
              >
                &times;
              </button>
            </div>
            <div style={{ padding: '12px 16px' }}>
              <button onClick={handleNew} disabled={creating()} style={{ width: '100%', padding: '10px', background: creating() ? '#1a1a2e' : '#4aba6a', color: creating() ? '#666' : '#000', border: 'none', 'border-radius': '8px', 'font-size': '14px', 'font-weight': '600', cursor: creating() ? 'wait' : 'pointer' }}>
                {creating() ? 'Starting...' : '+ New Claude'}
              </button>
            </div>
            <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch' }}>
              <For each={sessions()}>{(s) => (
                <button
                  onClick={() => select(s.id)}
                  aria-current={s.id === currentId() ? 'page' : undefined}
                  style={{ width: '100%', padding: '12px 16px', 'min-height': '44px', cursor: 'pointer', 'border-left': s.id === currentId() ? '3px solid #4aba6a' : '3px solid transparent', background: s.id === currentId() ? '#1a1a2e' : 'transparent', 'border-bottom': '1px solid #111', border: 'none', color: 'inherit', 'text-align': 'left' }}
                >
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                    <Show when={s.isActive}><span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>
                    <span style={{ 'font-size': '13px', 'font-weight': '500', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }}>{s.title}</span>
                    <span style={{ 'font-size': '11px', color: '#7c8595' }}>{timeAgo(s.updatedAt)}</span>
                  </div>
                </button>
              )}</For>
            </div>
          </div>
      </div>

      {/* Main */}
      <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-width': '0', height: '100%' }}>
        {/* Header */}
        <div style={{ padding: '8px 16px 0 68px', 'border-bottom': '1px solid #1e1e1e', display: 'flex', 'align-items': 'center', gap: '8px', 'min-height': '48px', 'flex-shrink': '0' }}>
          <Show when={cur()} fallback={<h1 style={{ color: '#666', 'font-size': '14px', 'font-weight': '600' }}>Select a session</h1>}>
            {(s) => <>
              <Show when={s().isActive}><span style={{ width: '8px', height: '8px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>
              <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'font-size': '14px', 'font-weight': '600' }}>{s().title}</span>
              <div style={{ flex: '1' }} />
              <Show when={!s().isActive}>
                <button
                  onClick={() => handleResume(s().id)}
                  style={{
                    background: '#4aba6a',
                    color: '#000',
                    border: 'none',
                    'border-radius': '8px',
                    padding: '0 14px',
                    'min-width': '44px',
                    height: '44px',
                    display: 'inline-flex',
                    'align-items': 'center',
                    'justify-content': 'center',
                    'font-size': '12px',
                    'font-weight': '600',
                    cursor: 'pointer',
                    'flex-shrink': '0',
                  }}
                >
                  Resume
                </button>
              </Show>
            </>}
          </Show>
        </div>

        {/* Tabs */}
        <Show when={currentId()}>
          <div style={{ display: 'flex', 'border-bottom': '1px solid #1e1e1e', 'padding-left': '16px', 'flex-shrink': '0' }}>
            <button onClick={() => setTab('chat')} style={tabStyle('chat')}>Chat</button>
            <button onClick={() => setTab('terminal')} style={tabStyle('terminal')}>Terminal</button>
          </div>
        </Show>

        {/* Content */}
        <div style={{ flex: '1', overflow: 'hidden' }}>
          <Show when={currentId()} fallback={
            <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'center', height: '100%', color: '#444', padding: '24px' }}>
              <div style={{ 'text-align': 'center', width: '100%', 'max-width': '320px', display: 'flex', 'flex-direction': 'column', 'align-items': 'center', gap: '12px' }}>
                <p style={{ color: '#7c8595', 'font-size': '14px', 'line-height': '1.5' }}>Open a session or create a new one</p>
                <button
                  onClick={handleNew}
                  disabled={creating()}
                  style={{
                    width: '100%',
                    'max-width': '240px',
                    height: '44px',
                    background: creating() ? '#1a1a2e' : '#4aba6a',
                    color: creating() ? '#666' : '#000',
                    border: 'none',
                    'border-radius': '10px',
                    'font-size': '14px',
                    'font-weight': '600',
                    cursor: creating() ? 'wait' : 'pointer',
                  }}
                >
                  {creating() ? 'Starting...' : 'Start a new session'}
                </button>
              </div>
            </div>
          }>
            <div style={{ display: tab() === 'chat' ? 'block' : 'none', height: '100%' }}>
              <MessageView messages={messages()} loading={loading()} />
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
                  <button onClick={() => removeFile(i())} style={{ position: 'absolute', top: '-6px', right: '-6px', width: '18px', height: '18px', 'border-radius': '50%', background: '#d45555', color: '#fff', border: 'none', 'font-size': '11px', cursor: 'pointer', display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'line-height': '1' }}>&times;</button>
                </div>
              )}</For>
            </div>
          </Show>
          <div style={{ padding: '8px 12px', 'padding-bottom': 'max(8px, env(safe-area-inset-bottom))', 'border-top': files().length ? 'none' : '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', gap: '8px', 'align-items': 'flex-end', 'flex-shrink': '0' }}>
            <button
              onClick={() => fileInputRef?.click()}
              aria-label="Attach file"
              style={{
                background: 'none',
                border: 'none',
                color: '#666',
                'font-size': '20px',
                cursor: 'pointer',
                width: '44px',
                height: '44px',
                padding: '0',
                'line-height': '1',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'center',
                'flex-shrink': '0',
              }}
              title="Attach file"
            >
              +
            </button>
            <textarea ref={textareaRef} value={text()}
              onInput={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px' }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
              onPaste={(e) => { const items = e.clipboardData?.items; if (!items) return; const imgs = [...items].filter(i => i.type.startsWith('image/')); if (imgs.length) { e.preventDefault(); addFiles(imgs.map(i => new File([i.getAsFile()!], 'pasted-image.png', { type: i.type }))) } }}
              placeholder="Send a message..." rows={1}
              style={{ flex: '1', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '12px', padding: '10px 14px', color: '#e5e5e5', 'font-size': '15px', 'font-family': 'inherit', resize: 'none', outline: 'none', 'line-height': '1.4', 'max-height': '120px' }} />
            <button onClick={handleSend} disabled={uploading() || (!text().trim() && files().length === 0)} style={{ background: (text().trim() || files().length) ? '#4aba6a' : '#333', color: (text().trim() || files().length) ? '#000' : '#666', border: 'none', 'border-radius': '12px', padding: '0 16px', 'font-size': '15px', 'font-weight': '600', cursor: (text().trim() || files().length) ? 'pointer' : 'default', 'min-height': '44px', display: 'inline-flex', 'align-items': 'center', 'justify-content': 'center', 'flex-shrink': '0' }}>{uploading() ? '...' : 'Send'}</button>
          </div>
        </Show>
      </div>
    </div>
  )
}
