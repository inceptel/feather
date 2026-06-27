import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js'
import { fetchSidecars, fetchSidecar, createSidecar, postSidecar, deleteSidecar, subscribeSidecar } from '../api'
import type { SidecarGroup, SidecarMessage } from '../api'

// Sidecar panel: a paired peer thread layered over ordinary Feather sessions.
// v1 = the chat thread (the "watch them talk" view) + links to open each member
// session. See docs/plans/2026-06-27-001-feature-sidecar-plan.md
export function Sidecar(props: { currentId: () => string | null; onOpenSession: (id: string) => void }) {
  const [groups, setGroups] = createSignal<SidecarGroup[]>([])
  const [openId, setOpenId] = createSignal<string | null>(null)
  const [thread, setThread] = createSignal<SidecarMessage[]>([])
  const [draft, setDraft] = createSignal('')

  async function refresh() {
    try { setGroups((await fetchSidecars()).groups || []) } catch {}
  }
  refresh()
  const poll = setInterval(refresh, 5000)
  onCleanup(() => clearInterval(poll))

  // Live thread for the open group.
  createEffect(() => {
    const id = openId()
    setThread([])
    if (!id) return
    fetchSidecar(id).then(r => setThread(r.thread || [])).catch(() => {})
    const unsub = subscribeSidecar(id, (m) => setThread(prev => [...prev, m]))
    onCleanup(unsub)
  })

  const openGroup = () => groups().find(g => g.id === openId()) || null
  const peerRole = () => openGroup()?.members.find(m => m.spawned)?.role || 'peer'

  async function spawn() {
    const driver = props.currentId()
    if (!driver) { alert('Open a session first — it becomes the sidecar driver.'); return }
    const task = prompt('Task / opening message for the sidecar (optional):') ?? ''
    const agent = (prompt('Agent for the peer (claude / codex):', 'claude') || 'claude').trim()
    try {
      const r = await createSidecar(driver, { task, agent })
      await refresh()
      setOpenId(r.group.id)
    } catch (e: any) { alert('Failed to spawn sidecar: ' + (e?.message || e)) }
  }

  async function send() {
    const id = openId(); const text = draft().trim()
    if (!id || !text) return
    setDraft('')
    try { await postSidecar(id, peerRole(), text, 'driver') } catch (e: any) { alert('Send failed: ' + (e?.message || e)) }
  }

  async function kill(id: string) {
    if (!confirm('Tear down this sidecar? (kills the peer session)')) return
    try { await deleteSidecar(id); if (openId() === id) setOpenId(null); await refresh() } catch {}
  }

  const btn = { padding: '4px 8px', 'font-size': '11px', border: '1px solid #333', background: '#1a1a1a', color: '#bbb', cursor: 'pointer', 'border-radius': '4px' } as const

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', height: '100%', color: '#e5e5e5', 'font-size': '13px' }}>
      <Show when={!openId()}>
        <div style={{ padding: '8px', display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
          <span style={{ color: '#888', 'font-size': '12px' }}>Sidecars</span>
          <button style={btn} onClick={spawn}>+ New sidecar</button>
        </div>
        <Show when={groups().length === 0}>
          <div style={{ padding: '12px', color: '#666', 'font-size': '12px' }}>
            No sidecars. Open a session, then “+ New sidecar” to spawn a peer thread you can chat with.
          </div>
        </Show>
        <For each={groups()}>{(g) => (
          <div onClick={() => setOpenId(g.id)} style={{ padding: '8px 10px', 'border-bottom': '1px solid #222', cursor: 'pointer', display: 'flex', 'justify-content': 'space-between', 'align-items': 'center' }}>
            <div>
              <div style={{ color: g.status === 'active' ? '#e5e5e5' : '#777' }}>
                {g.members.map(m => m.role).join(' ↔ ')}
              </div>
              <div style={{ color: '#666', 'font-size': '11px' }}>{g.agent} · {g.status}</div>
            </div>
            <button style={btn} onClick={(e) => { e.stopPropagation(); kill(g.id) }}>✕</button>
          </div>
        )}</For>
      </Show>

      <Show when={openId()}>
        <div style={{ padding: '8px', 'border-bottom': '1px solid #222', display: 'flex', 'align-items': 'center', gap: '8px' }}>
          <button style={btn} onClick={() => setOpenId(null)}>‹ Back</button>
          <span style={{ flex: '1', color: '#888', 'font-size': '12px' }}>{openGroup()?.members.map(m => m.role).join(' ↔ ')}</span>
          <For each={openGroup()?.members || []}>{(m) => (
            <button style={btn} onClick={() => props.onOpenSession(m.sessionId)}>open {m.role}</button>
          )}</For>
        </div>
        <div style={{ flex: '1', overflow: 'auto', padding: '8px', display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <For each={thread()}>{(m) => (
            <div style={{ 'border-left': '2px solid #333', padding: '2px 8px' }}>
              <div style={{ color: '#6aa6e5', 'font-size': '11px' }}>{m.from} → {m.to}</div>
              <div style={{ 'white-space': 'pre-wrap' }}>{m.text}</div>
            </div>
          )}</For>
        </div>
        <div style={{ padding: '8px', 'border-top': '1px solid #222', display: 'flex', gap: '6px' }}>
          <input
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send() }}
            placeholder={`message ${peerRole()}…`}
            style={{ flex: '1', padding: '6px', background: '#111', border: '1px solid #333', color: '#e5e5e5', 'border-radius': '4px' }}
          />
          <button style={btn} onClick={send}>Send</button>
        </div>
      </Show>
    </div>
  )
}
