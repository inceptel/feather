import { createSignal, createEffect, onCleanup, For, Show } from 'solid-js'
import { fetchSidecars, fetchSidecar, createSidecar, postSidecar, deleteSidecar, addSidecarPeer, removeSidecarPeer, subscribeSidecar } from '../api'
import type { SidecarGroup, SidecarMessage } from '../api'

// Sidecar panel: a paired/grouped peer thread layered over ordinary Feather
// sessions. Supports N peers per group with broadcast addressing.
// See docs/plans/2026-06-27-001 (v1) and -002 (multi-peer).
export function Sidecar(props: { currentId: () => string | null; onOpenSession: (id: string) => void }) {
  const [groups, setGroups] = createSignal<SidecarGroup[]>([])
  const [openId, setOpenId] = createSignal<string | null>(null)
  const [thread, setThread] = createSignal<SidecarMessage[]>([])
  const [draft, setDraft] = createSignal('')
  const [recipient, setRecipient] = createSignal('')

  async function refresh() {
    try { setGroups((await fetchSidecars()).groups || []) } catch {}
  }
  refresh()
  const poll = setInterval(refresh, 5000)
  onCleanup(() => clearInterval(poll))

  createEffect(() => {
    const id = openId()
    setThread([])
    if (!id) return
    fetchSidecar(id).then(r => setThread(r.thread || [])).catch(() => {})
    const unsub = subscribeSidecar(id, (m) => setThread(prev => [...prev, m]))
    onCleanup(unsub)
  })

  const openGroup = () => groups().find(g => g.id === openId()) || null
  const driverRole = () => openGroup()?.members.find(m => !m.spawned)?.role || 'driver'
  const peerRoles = () => (openGroup()?.members.filter(m => m.spawned) || []).map(m => m.role)
  // recipient options: broadcast (when 2+ peers) + each peer role
  const recipientOptions = () => {
    const peers = peerRoles()
    return (peers.length > 1 ? ['all', ...peers] : peers)
  }
  const currentRecipient = () => recipient() || recipientOptions()[0] || 'peer'

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

  async function addPeer() {
    const id = openId(); if (!id) return
    const role = (prompt('Role for the new peer (e.g. critic-perf):') || '').trim()
    if (!role) return
    const agent = (prompt('Agent (claude / codex):', 'claude') || 'claude').trim()
    const task = prompt('Task / rubric for this peer (optional):') ?? ''
    try { await addSidecarPeer(id, role, { agent, task }); await refresh() }
    catch (e: any) { alert('Add peer failed: ' + (e?.message || e)) }
  }

  async function removePeer(role: string) {
    const id = openId(); if (!id) return
    if (!confirm(`Remove peer "${role}"? (kills its session)`)) return
    try { await removeSidecarPeer(id, role); await refresh() } catch {}
  }

  async function send() {
    const id = openId(); const text = draft().trim()
    if (!id || !text) return
    setDraft('')
    try { await postSidecar(id, currentRecipient(), text, driverRole()) }
    catch (e: any) { alert('Send failed: ' + (e?.message || e)) }
  }

  async function kill(id: string) {
    if (!confirm('Tear down this sidecar? (kills all spawned peers)')) return
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
              <div style={{ color: g.status === 'active' ? '#e5e5e5' : '#777' }}>{g.members.map(m => m.role).join(' ↔ ')}</div>
              <div style={{ color: '#666', 'font-size': '11px' }}>{g.agent} · {g.status} · {g.members.length} members</div>
            </div>
            <button style={btn} onClick={(e) => { e.stopPropagation(); kill(g.id) }}>✕</button>
          </div>
        )}</For>
      </Show>

      <Show when={openId()}>
        <div style={{ padding: '8px', 'border-bottom': '1px solid #222', display: 'flex', 'align-items': 'center', gap: '6px', 'flex-wrap': 'wrap' }}>
          <button style={btn} onClick={() => setOpenId(null)}>‹ Back</button>
          <For each={openGroup()?.members || []}>{(m) => (
            <span style={{ display: 'inline-flex', 'align-items': 'center', gap: '2px' }}>
              <button style={btn} onClick={() => props.onOpenSession(m.sessionId)}>open {m.role}</button>
              <Show when={m.spawned}>
                <button style={{ ...btn, padding: '4px 6px' }} title={`remove ${m.role}`} onClick={() => removePeer(m.role)}>×</button>
              </Show>
            </span>
          )}</For>
          <button style={{ ...btn, color: '#6aa6e5' }} onClick={addPeer}>+ peer</button>
        </div>
        <div style={{ flex: '1', overflow: 'auto', padding: '8px', display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          <For each={thread()}>{(m) => (
            <div style={{ 'border-left': '2px solid #333', padding: '2px 8px' }}>
              <div style={{ color: '#6aa6e5', 'font-size': '11px' }}>{m.from} → {m.to}</div>
              <div style={{ 'white-space': 'pre-wrap' }}>{m.text}</div>
            </div>
          )}</For>
        </div>
        <div style={{ padding: '8px', 'border-top': '1px solid #222', display: 'flex', gap: '6px', 'align-items': 'center' }}>
          <select value={currentRecipient()} onChange={(e) => setRecipient(e.currentTarget.value)} style={{ background: '#111', border: '1px solid #333', color: '#e5e5e5', 'border-radius': '4px', padding: '6px' }}>
            <For each={recipientOptions()}>{(r) => <option value={r}>{r}</option>}</For>
          </select>
          <input
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send() }}
            placeholder={`message ${currentRecipient()}…`}
            style={{ flex: '1', padding: '6px', background: '#111', border: '1px solid #333', color: '#e5e5e5', 'border-radius': '4px' }}
          />
          <button style={btn} onClick={send}>Send</button>
        </div>
      </Show>
    </div>
  )
}
