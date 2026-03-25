import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { MessageView } from './components/MessageView'
import { Terminal } from './components/Terminal'
import type { SessionMeta, Message } from './api'
import { fetchSessions, fetchMessages, subscribeMessages, sendInput, createSession, resumeSession } from './api'

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
  let cleanupSSE: (() => void) | null = null
  let textareaRef: HTMLTextAreaElement | undefined

  onMount(async () => setSessions(await fetchSessions()))
  onCleanup(() => cleanupSSE?.())

  async function select(id: string) {
    setCurrentId(id)
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

  function handleSend() {
    const val = text().trim()
    if (!val || !currentId()) return
    const tempId = `optimistic-${Date.now()}`
    // Optimistic insert with single check
    setMessages(prev => [...prev, {
      uuid: tempId,
      role: 'user',
      timestamp: new Date().toISOString(),
      content: [{ type: 'text', text: val }],
      delivery: 'sent',
    }])
    sendInput(currentId()!, val)
    setText('')
    if (textareaRef) textareaRef.style.height = 'auto'
  }

  const cur = () => sessions().find(s => s.id === currentId())
  const tabStyle = (t: string) => ({
    padding: '6px 16px', border: 'none', 'border-bottom': tab() === t ? '2px solid #4aba6a' : '2px solid transparent',
    background: 'none', color: tab() === t ? '#e5e5e5' : '#666', 'font-size': '13px', 'font-weight': '600', cursor: 'pointer',
  })

  return (
    <div style={{ display: 'flex', height: 'calc(var(--vh, 1vh) * 100)', width: '100%', 'font-family': "-apple-system, BlinkMacSystemFont, 'SF Pro', system-ui, sans-serif" }}>

      {/* Hamburger */}
      <Show when={!sidebar()}>
        <button onClick={() => setSidebar(true)} style={{ position: 'fixed', top: '12px', left: '12px', 'z-index': '50', background: '#1a1a2e', border: '1px solid #333', color: '#e5e5e5', width: '36px', height: '36px', 'border-radius': '8px', 'font-size': '18px', cursor: 'pointer', display: 'flex', 'align-items': 'center', 'justify-content': 'center' }}>&#9776;</button>
      </Show>

      {/* Sidebar */}
      <div style={{ width: sidebar() ? '300px' : '0', 'min-width': sidebar() ? '300px' : '0', height: '100%', background: '#0d1117', 'border-right': sidebar() ? '1px solid #1e1e1e' : 'none', overflow: 'hidden', transition: 'width 0.2s, min-width 0.2s', 'z-index': '40' }}>
        <Show when={sidebar()}>
          <div style={{ display: 'flex', 'flex-direction': 'column', height: '100%' }}>
            <div style={{ padding: '12px 16px', display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', 'border-bottom': '1px solid #1e1e1e' }}>
              <span style={{ 'font-weight': '700', 'font-size': '16px' }}>Feather</span>
              <button onClick={() => setSidebar(false)} style={{ background: 'none', border: 'none', color: '#666', 'font-size': '20px', cursor: 'pointer' }}>&times;</button>
            </div>
            <div style={{ padding: '12px 16px' }}>
              <button onClick={handleNew} disabled={creating()} style={{ width: '100%', padding: '10px', background: creating() ? '#1a1a2e' : '#4aba6a', color: creating() ? '#666' : '#000', border: 'none', 'border-radius': '8px', 'font-size': '14px', 'font-weight': '600', cursor: creating() ? 'wait' : 'pointer' }}>
                {creating() ? 'Starting...' : '+ New Claude'}
              </button>
            </div>
            <div style={{ flex: '1', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch' }}>
              <For each={sessions()}>{(s) => (
                <div onClick={() => select(s.id)} style={{ padding: '12px 16px', cursor: 'pointer', 'border-left': s.id === currentId() ? '3px solid #4aba6a' : '3px solid transparent', background: s.id === currentId() ? '#1a1a2e' : 'transparent', 'border-bottom': '1px solid #111' }}>
                  <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                    <Show when={s.isActive}><span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>
                    <span style={{ 'font-size': '13px', 'font-weight': '500', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }}>{s.title}</span>
                    <span style={{ 'font-size': '11px', color: '#555' }}>{timeAgo(s.updatedAt)}</span>
                  </div>
                </div>
              )}</For>
            </div>
          </div>
        </Show>
      </div>

      {/* Main */}
      <div style={{ flex: '1', display: 'flex', 'flex-direction': 'column', 'min-width': '0', height: '100%' }}>
        {/* Header */}
        <div style={{ padding: '8px 16px 0 56px', 'border-bottom': '1px solid #1e1e1e', display: 'flex', 'align-items': 'center', gap: '8px', 'min-height': '48px', 'flex-shrink': '0' }}>
          <Show when={cur()} fallback={<span style={{ color: '#666', 'font-size': '14px' }}>Select a session</span>}>
            {(s) => <>
              <Show when={s().isActive}><span style={{ width: '8px', height: '8px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>
              <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'font-size': '14px', 'font-weight': '600' }}>{s().title}</span>
              <div style={{ flex: '1' }} />
              <Show when={!s().isActive}>
                <button onClick={() => handleResume(s().id)} style={{ background: '#4aba6a', color: '#000', border: 'none', 'border-radius': '6px', padding: '4px 12px', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer' }}>Resume</button>
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
            <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'center', height: '100%', color: '#444' }}>
              <div style={{ 'text-align': 'center' }}>
                <div style={{ 'font-size': '32px', 'margin-bottom': '12px', opacity: '0.3' }}>~</div>
                <div>Open a session or create a new one</div>
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

        {/* Input (chat tab only) */}
        <Show when={currentId() && tab() === 'chat'}>
          <div style={{ padding: '8px 12px', 'padding-bottom': 'max(8px, env(safe-area-inset-bottom))', 'border-top': '1px solid #1e1e1e', background: '#0a0e14', display: 'flex', gap: '8px', 'align-items': 'flex-end', 'flex-shrink': '0' }}>
            <textarea ref={textareaRef} value={text()} onInput={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px' }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }} placeholder="Send a message..." rows={1} style={{ flex: '1', background: '#1a1a2e', border: '1px solid #333', 'border-radius': '12px', padding: '10px 14px', color: '#e5e5e5', 'font-size': '15px', 'font-family': 'inherit', resize: 'none', outline: 'none', 'line-height': '1.4', 'max-height': '120px' }} />
            <button onClick={handleSend} style={{ background: text().trim() ? '#4aba6a' : '#333', color: text().trim() ? '#000' : '#666', border: 'none', 'border-radius': '12px', padding: '10px 16px', 'font-size': '15px', 'font-weight': '600', cursor: text().trim() ? 'pointer' : 'default', 'min-height': '42px' }}>Send</button>
          </div>
        </Show>
      </div>
    </div>
  )
}
