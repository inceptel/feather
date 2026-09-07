import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { fetchRooms, fetchRoomFriction, fetchSuperFeed, setRoomPulse, setRoomResidentsPaused, setRoomLeaderWake, succeedRoomLeader, createSession, RoomInfo, RoomResident, FrictionComplaint, SuperFeedItem } from '../api'
import { RoomWikiView } from './RoomWikiView'
import { renderWikiMarkdown } from './MessageView'

// One Room, on one page: the mission, who lives here and when they wake, the
// Wiki, the cards this Room has published, and its open friction. Reached from
// #room/<name>; the Rooms list and the Super Feed link here.

const ink = '#e6ebf2'
const body = '#c9d1dc'
const muted = '#8b97a8'
const line = '#1e2632'
const green = '#69c77f'
const amber = '#e0b45f'
const panel = '#0f141b'

function timeAgo(iso: string | null | undefined) {
  if (!iso) return ''
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function timeUntilMs(at: number | null | undefined) {
  if (!at) return ''
  const m = Math.max(0, Math.ceil((at - Date.now()) / 60000))
  if (m < 1) return 'now'
  if (m < 60) return `in ${m}m`
  return `in ${Math.ceil(m / 60)}h`
}

function roleLabel(role: string) {
  return role.split('-').map(part => part ? part[0].toUpperCase() + part.slice(1) : '').join(' ')
}

function whenLabel(iso: string | null | undefined) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const cardStyle = { background: panel, border: `1px solid ${line}`, 'border-radius': '12px', padding: '12px 14px', 'margin-bottom': '10px' }
const sectionTitle = { color: muted, 'font-size': '11px', 'font-weight': '700', 'text-transform': 'uppercase' as const, 'letter-spacing': '0.06em', margin: '0 0 8px' }
const buttonStyle = (accent = false) => ({
  background: accent ? '#152a1c' : 'transparent', border: `1px solid ${accent ? '#2a4a34' : '#2a3346'}`, color: accent ? green : '#9aa4b2',
  'font-size': '12px', 'font-weight': '600', padding: '6px 12px', 'border-radius': '8px', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent',
})

export function RoomPage(props: { name: string, onOpenSession: (id: string) => void, onBack: () => void, onSessionsChanged?: () => void }) {
  const [room, setRoom] = createSignal<RoomInfo | null>(null)
  const [missing, setMissing] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [cards, setCards] = createSignal<SuperFeedItem[]>([])
  const [friction, setFriction] = createSignal<FrictionComplaint[]>([])
  const [busy, setBusy] = createSignal(false)
  const [showWiki, setShowWiki] = createSignal(true)

  async function refresh() {
    try {
      const rooms = await fetchRooms()
      const next = rooms.find(candidate => candidate.name === props.name) || null
      setRoom(next)
      setMissing(!next)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
    try {
      const feed = await fetchSuperFeed()
      if (feed.snapshot) setCards(feed.snapshot.items.filter(item => item.room === props.name && item.kind !== 'friction').slice(0, 8))
    } catch {}
    try { setFriction(await fetchRoomFriction(props.name)) } catch {}
  }

  let timer: ReturnType<typeof setInterval>
  onMount(() => { refresh(); timer = setInterval(refresh, 15_000) })
  onCleanup(() => clearInterval(timer))

  const leaderEntry = createMemo(() => room()?.residents.find(resident => resident.role === 'leader') || null)
  const leader = createMemo(() => {
    const current = room()
    if (!current || !current.leaderSessionId) return null
    const session = current.sessions.find(candidate => candidate.id === current.leaderSessionId)
    if (session) return session
    // Just appointed: no transcript yet, so discovery has nothing. The server
    // still reports it as a 'starting' resident.
    const entry = leaderEntry()
    if (!entry) return null
    return { id: entry.sessionId, title: entry.title, agent: entry.agent, isActive: false, updatedAt: '' }
  })
  const leaderStarting = createMemo(() => leaderEntry()?.status === 'starting')
  const leaderContext = createMemo(() => {
    const percent = leaderEntry()?.contextPercent
    return typeof percent === 'number' ? Math.round(percent) : null
  })
  const residents = createMemo(() => (room()?.residents || []).filter(resident => resident.role !== 'leader'))
  const paused = createMemo(() => room()?.residentsPaused === true)
  const openFriction = createMemo(() => friction().filter(complaint => !complaint.resolvedAt))

  async function openLeader() {
    const current = room()
    if (!current || busy()) return
    const existing = leader()
    if (existing) return props.onOpenSession(existing.id)
    setBusy(true)
    try {
      const id = await createSession(current.cwd, 'omp', { name: current.name, role: 'leader' })
      props.onSessionsChanged?.()
      props.onOpenSession(id)
    } catch (caught) { alert(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }

  async function retireLeader() {
    const current = room()
    if (!current || busy() || !leader()) return
    const context = leaderContext()
    if (!confirm(`Retire the Leader of #${current.name}${context !== null ? ` (${context}% context used)` : ''}?\n\nFeather writes its handoff into notes.md, closes the chat, and seats a fresh Leader. The old chat stays visible in the Room.`)) return
    setBusy(true)
    try {
      const result = await succeedRoomLeader(current.name)
      props.onSessionsChanged?.()
      await refresh()
      props.onOpenSession(result.leaderSessionId)
    } catch (caught) { alert(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }

  async function togglePaused() {
    const current = room()
    if (!current || busy()) return
    const next = !paused()
    setBusy(true)
    try {
      await setRoomResidentsPaused(current.name, next)
      await setRoomPulse(current.name, !next)
      await refresh()
    } catch (caught) { alert(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }

  const AUTONOMY_CHOICES: Array<{ label: string, ms: number | null }> = [
    { label: 'Off', ms: null }, { label: '15m', ms: 15 * 60_000 }, { label: '30m', ms: 30 * 60_000 }, { label: '1h', ms: 3_600_000 }, { label: '2h', ms: 2 * 3_600_000 },
  ]
  const leaderWake = createMemo(() => room()?.leaderWake || null)
  const autonomyOn = createMemo(() => Boolean(leaderWake()?.wakeIntervalMs))

  async function autonomy(body: { wakeIntervalMs?: number | null, paused?: boolean, now?: boolean, judge?: boolean }) {
    const current = room()
    if (!current || busy()) return
    if (body.wakeIntervalMs === null && autonomyOn() && !confirm(`Switch off autonomy for #${current.name}? The Leader stops waking on its own.`)) return
    setBusy(true)
    try {
      await setRoomLeaderWake(current.name, body)
      await refresh()
    } catch (caught) { alert(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }

  function residentStatus(resident: RoomResident) {
    if (resident.status === 'working') return { text: 'working now', color: green }
    if (resident.status === 'offline') return { text: 'offline', color: muted }
    if (resident.paused) return { text: 'paused', color: amber }
    if (resident.wakeIntervalMs === null || resident.wakeIntervalMs === undefined) {
      if (resident.role === 'judge') return { text: leaderWake()?.judgeDue ? 'grading due after this Leader wake' : 'woken after each Leader wake', color: muted }
      if (resident.role === 'replyguy') return { text: 'woken by each comment', color: muted }
      return { text: 'woken by the updater', color: muted }
    }
    return { text: `wakes ${timeUntilMs(resident.nextWakeAtMs)}`, color: body }
  }

  return (
    <div data-testid={`room-page-${props.name}`} style={{ height: '100%', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch' }}>
      <div style={{ 'max-width': '640px', margin: '0 auto', padding: '12px 12px 40px' }}>
        <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'margin-bottom': '10px' }}>
          <button data-testid="room-page-back" onClick={props.onBack} style={{ background: 'none', border: 'none', color: muted, 'font-size': '13px', padding: '4px 6px 4px 0', cursor: 'pointer' }}>‹ Rooms</button>
          <span style={{ 'font-size': '18px', 'font-weight': '700', color: ink }}>#{props.name}</span>
          <Show when={room()?.active}><span style={{ width: '8px', height: '8px', 'border-radius': '50%', background: green }} /></Show>
          <span style={{ 'margin-left': 'auto', color: muted, 'font-size': '11px', 'font-family': 'monospace' }}>{room()?.updatedAt ? `${timeAgo(room()!.updatedAt)} ago` : ''}</span>
        </div>

        <Show when={error()}><div style={{ color: '#d45555', 'font-size': '13px', padding: '8px 4px' }}>{error()}</div></Show>
        <Show when={missing()}>
          <div style={{ color: muted, 'text-align': 'center', padding: '40px', 'font-size': '13px' }}>No Room named #{props.name}.</div>
        </Show>

        <Show when={room()}>{(current) => <>
          <section data-testid="room-mission" style={cardStyle}>
            <div style={sectionTitle}>Mission</div>
            <Show when={current().mission} fallback={<div style={{ color: muted, 'font-size': '13px' }}>No mission sentence yet. Add one under "## Mission" in AGENTS.md.</div>}>
              <div style={{ color: ink, 'font-size': '15px', 'line-height': '1.5', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{current().mission}</div>
            </Show>
            <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '8px', 'margin-top': '12px' }}>
              <button data-testid="room-open-leader" onClick={openLeader} disabled={busy()} style={buttonStyle(true)}>{leader() ? 'Open Leader chat' : 'Start Leader chat'}</button>
              <Show when={leader()}>
                <button data-testid="room-retire-leader" onClick={retireLeader} disabled={busy()} style={buttonStyle()}>{busy() ? 'Working…' : 'Retire Leader'}</button>
              </Show>
              <button data-testid="room-toggle-paused" onClick={togglePaused} disabled={busy() || residents().length === 0} aria-pressed={paused()} style={buttonStyle()}>
                {paused() ? 'Resume residents' : 'Pause residents'}
              </button>
              <Show when={paused()}><span style={{ color: amber, 'font-size': '12px', 'align-self': 'center' }}>Paused: no wakes, no status reports</span></Show>
            </div>
            <div data-testid="room-autonomy" style={{ display: 'flex', 'flex-wrap': 'wrap', 'align-items': 'center', gap: '6px', 'margin-top': '12px' }}>
              <span style={{ color: muted, 'font-size': '12px', 'margin-right': '4px' }}>Leader wakes</span>
              <For each={AUTONOMY_CHOICES}>{(choice) => {
                const selected = () => (leaderWake()?.wakeIntervalMs ?? null) === choice.ms
                return <button data-testid={`room-autonomy-${choice.label.toLowerCase()}`} onClick={() => autonomy({ wakeIntervalMs: choice.ms })} disabled={busy() || selected()} aria-pressed={selected()} style={{ ...buttonStyle(selected()), padding: '4px 9px' }}>{choice.label}</button>
              }}</For>
              <Show when={autonomyOn()}>
                <button data-testid="room-autonomy-pause" onClick={() => autonomy({ paused: !leaderWake()!.paused })} disabled={busy()} style={{ ...buttonStyle(), padding: '4px 9px' }}>{leaderWake()!.paused ? 'Resume' : 'Pause'}</button>
                <button data-testid="room-autonomy-now" onClick={() => autonomy({ now: true })} disabled={busy() || !leader()} style={{ ...buttonStyle(), padding: '4px 9px' }}>Wake now</button>
                <button data-testid="room-autonomy-judge" onClick={() => autonomy({ judge: true })} disabled={busy()} style={{ ...buttonStyle(), padding: '4px 9px' }}>Judge now</button>
              </Show>
            </div>
            <Show when={autonomyOn()}>
              <div style={{ color: leaderWake()!.paused ? amber : muted, 'font-size': '12px', 'margin-top': '6px' }}>
                {leaderWake()!.paused ? 'Autonomy paused.' : `Next wake ${timeUntilMs(leaderWake()!.nextWakeAtMs)}.`}
                {leaderWake()!.lastWakeAt ? ` Last wake ${timeAgo(leaderWake()!.lastWakeAt!)} ago.` : ''}
                {leaderWake()!.lastJudgeAt ? ` Last judged ${timeAgo(leaderWake()!.lastJudgeAt!)} ago.` : ''}
                {' '}Work comes from FRONTIER.md; put your own steering at the top of it.
              </div>
            </Show>
            <Show when={leaderWake()?.fallback}>{(fallback) => (
              <div data-testid="room-autonomy-fallback" style={{ color: amber, 'font-size': '12px', 'margin-top': '6px' }}>
                On fallback model {fallback().model} since {whenLabel(fallback().since)} ({fallback().reason}). Retries {fallback().primaryModel} at {whenLabel(fallback().retryAt)}.
              </div>
            )}</Show>
          </section>

          <section data-testid="room-residents" style={cardStyle}>
            <div style={sectionTitle}>Who lives here</div>
            <div data-testid="room-resident-leader" style={{ display: 'flex', 'align-items': 'center', gap: '10px', padding: '6px 0', 'border-bottom': `1px solid ${line}`, cursor: leader() ? 'pointer' : 'default' }} onClick={() => { const session = leader(); if (session) props.onOpenSession(session.id) }}>
              <span style={{ width: '7px', height: '7px', 'border-radius': '50%', background: leader()?.isActive ? green : '#333', 'flex-shrink': '0' }} />
              <span style={{ color: ink, 'font-size': '13px', 'font-weight': '600' }}>Leader</span>
              <span style={{ color: muted, 'font-size': '12px', flex: '1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{leader() ? `${leader()!.agent} · ${leader()!.title}` : 'not started'}</span>
              <Show when={leaderContext() !== null}>
                <span data-testid="room-leader-context" title={leaderEntry()?.model ? `model ${leaderEntry()!.model}` : undefined} style={{ color: (leaderContext() ?? 0) >= 85 ? '#e0605a' : (leaderContext() ?? 0) >= 60 ? amber : muted, 'font-size': '11px', 'font-family': 'monospace' }}>{leaderContext()}% ctx</span>
              </Show>
              <Show when={leaderEntry()?.model}>
                <span data-testid="room-leader-model" style={{ color: leaderWake()?.fallback ? amber : muted, 'font-size': '11px', 'font-family': 'monospace', 'white-space': 'nowrap' }}>{leaderWake()?.fallback ? 'fallback · ' : ''}{leaderEntry()!.model!.split('/').pop()}</span>
              </Show>
              <span style={{ color: muted, 'font-size': '11px', 'font-family': 'monospace' }}>{leaderStarting() ? 'starting' : leader() ? timeAgo(leader()!.updatedAt) : ''}</span>
            </div>
            <Show when={residents().length === 0}><div style={{ color: muted, 'font-size': '12px', padding: '8px 0 2px' }}>No residents. Rooms created with a mission get a caretaker, an updater, a marketer, a replyguy, and a judge.</div></Show>
            <For each={residents()}>{(resident) => {
              const status = residentStatus(resident)
              const session = current().sessions.find(candidate => candidate.id === resident.sessionId)
              return (
                <div data-testid={`room-resident-${resident.role}`} onClick={() => { if (session) props.onOpenSession(session.id) }}
                  style={{ display: 'flex', 'align-items': 'center', gap: '10px', padding: '7px 0', 'border-bottom': `1px solid ${line}`, cursor: session ? 'pointer' : 'default' }}>
                  <span style={{ width: '7px', height: '7px', 'border-radius': '50%', background: resident.status === 'working' ? green : resident.paused ? amber : '#333', 'flex-shrink': '0' }} />
                  <span style={{ color: ink, 'font-size': '13px', 'font-weight': '600', 'min-width': '84px' }}>{roleLabel(resident.role)}</span>
                  <span style={{ color: status.color, 'font-size': '12px', flex: '1' }}>{status.text}</span>
                  <span style={{ color: muted, 'font-size': '11px', 'font-family': 'monospace', 'white-space': 'nowrap' }}>
                    {resident.wakeIntervalMs ? `every ${Math.round(resident.wakeIntervalMs / 60000)}m` : ''}{resident.lastWakeAt ? ` · last ${timeAgo(resident.lastWakeAt)}` : ''}
                  </span>
                </div>
              )
            }}</For>
          </section>

          <section data-testid="room-cards" style={cardStyle}>
            <div style={sectionTitle}>Recent cards</div>
            <Show when={cards().length > 0} fallback={<div style={{ color: muted, 'font-size': '13px' }}>Nothing published yet. The updater publishes the kickoff plan first, then material findings.</div>}>
              <For each={cards()}>{(item) => (
                <article data-testid={`room-card-item-${item.evidenceId}`} onClick={() => { if (item.sessionId) props.onOpenSession(item.sessionId) }}
                  style={{ padding: '8px 0', 'border-bottom': `1px solid ${line}`, cursor: item.sessionId ? 'pointer' : 'default' }}>
                  <div style={{ display: 'flex', gap: '8px', 'align-items': 'baseline' }}>
                    <span style={{ color: ink, 'font-size': '14px', 'font-weight': '600', flex: '1', 'word-break': 'break-word' }}>{item.title.replace(new RegExp(`^#${props.name} · `), '')}</span>
                    <span style={{ color: muted, 'font-size': '11px', 'font-family': 'monospace', 'white-space': 'nowrap' }}>{whenLabel(item.occurredAt)}</span>
                  </div>
                  <div class="markdown" innerHTML={renderWikiMarkdown(item.summary)} style={{ color: body, 'font-size': '13px', 'margin-top': '3px' }} />
                </article>
              )}</For>
            </Show>
          </section>

          <section data-testid="room-friction" style={cardStyle}>
            <div style={sectionTitle}>Friction · {openFriction().length} open{friction().length - openFriction().length > 0 ? ` · ${friction().length - openFriction().length} resolved` : ''}</div>
            <Show when={friction().length > 0} fallback={<div style={{ color: muted, 'font-size': '13px' }}>No friction reported from #{props.name}.</div>}>
              <For each={friction()}>{(complaint) => (
                <div style={{ padding: '7px 0', 'border-bottom': `1px solid ${line}`, opacity: complaint.resolvedAt ? '0.7' : '1' }}>
                  <div style={{ display: 'flex', gap: '8px', 'align-items': 'baseline' }}>
                    <span style={{ color: complaint.resolvedAt ? green : amber, 'font-size': '10px', 'font-weight': '700', 'text-transform': 'uppercase' }}>{complaint.resolvedAt ? 'Resolved' : 'Open'}</span>
                    <span style={{ color: muted, 'font-size': '11px', 'font-family': 'monospace' }}>{whenLabel(complaint.timestamp)}</span>
                  </div>
                  <div style={{ color: ink, 'font-size': '13px', 'line-height': '1.45', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{complaint.summary}</div>
                  <Show when={complaint.resolution}><div style={{ color: body, 'font-size': '12px', 'margin-top': '3px' }}>{complaint.resolution}</div></Show>
                </div>
              )}</For>
            </Show>
          </section>

          <section style={{ ...cardStyle, padding: '0', overflow: 'hidden' }}>
            <button data-testid="room-wiki-toggle" onClick={() => setShowWiki(!showWiki())}
              style={{ width: '100%', background: 'none', border: 'none', color: muted, 'font-size': '11px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.06em', padding: '12px 14px', cursor: 'pointer', 'text-align': 'left' }}>
              Wiki {showWiki() ? '▾' : '▸'}
            </button>
            <Show when={showWiki()}>
              <div style={{ height: '60vh', 'border-top': `1px solid ${line}`, background: '#0a0d13' }}>
                <RoomWikiView room={props.name} />
              </div>
            </Show>
          </section>
        </>}</Show>
      </div>
    </div>
  )
}
