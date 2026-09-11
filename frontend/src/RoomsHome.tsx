import { createEffect, createMemo, createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { fetchRooms, fetchSessions, RoomInfo, SessionMeta } from './api'
import { appUrl } from './lib/appPath.js'
import { markdownCSS, renderWikiMarkdown } from './components/MessageView'
import { SuperFeed } from './components/SuperFeed'

type ChatPin = { id: string, title?: string, legacy?: boolean }
type WikiPage = { source: string, name: string, size: number, updatedAt: string }

function SharedWiki(props: { source?: string, refreshKey: number }) {
  const [pages, setPages] = createSignal<WikiPage[]>([])
  const [query, setQuery] = createSignal('')
  const [selected, setSelected] = createSignal<{ source: string, name: string } | null>(null)
  const [content, setContent] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  let generation = 0
  let pageGeneration = 0
  onCleanup(() => { ++generation; ++pageGeneration })
  const label = (source: string) => source === 'shared' ? 'Shared wiki' : source.replace(/^room:/, '')
  const filtered = createMemo(() => pages().filter(page => `${label(page.source)} ${page.name}`.toLowerCase().includes(query().toLowerCase())))

  async function openPage(page: { source: string, name: string }) {
    const own = ++pageGeneration
    setSelected(page)
    setContent('')
    setLoading(true)
    setError('')
    try {
      const response = await fetch(appUrl(`/api/wiki/page?${new URLSearchParams(page)}`))
      if (!response.ok) throw new Error('Could not load wiki page')
      const data = await response.json()
      if (own === pageGeneration) setContent(data.content)
    } catch (cause) {
      if (own === pageGeneration) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (own === pageGeneration) setLoading(false) }
  }

  createEffect(() => {
    props.refreshKey
    const source = props.source ? `room:${props.source}` : 'shared'
    const own = ++generation
    const ownPage = ++pageGeneration
    setLoading(true)
    setError('')
    fetch(appUrl('/api/wiki')).then(async response => {
      if (!response.ok) throw new Error('Could not load wiki')
      const data = await response.json()
      if (own !== generation) return
      setPages(data.pages)
      if (ownPage !== pageGeneration) return
      const first = data.pages.find((page: WikiPage) => page.source === source && page.name === 'Home') || data.pages.find((page: WikiPage) => page.source === source) || data.pages[0]
      if (first) await openPage(first)
      else { setSelected(null); setContent(''); setLoading(false) }
    }).catch(cause => {
      if (own === generation && ownPage === pageGeneration) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false) }
    })
  })

  function followLink(event: MouseEvent) {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') || ''
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
      anchor.setAttribute('target', '_blank'); anchor.setAttribute('rel', 'noopener noreferrer'); return
    }
    if (href.startsWith('#')) return
    event.preventDefault()
    const current = selected()
    if (!current) return
    let raw: string
    try { raw = decodeURIComponent(href.replace(/[#?].*$/, '')).replace(/\.md$/i, '') } catch { return }
    const parts = raw.startsWith('/') ? [] : current.name.split('/').slice(0, -1)
    for (const segment of raw.split('/')) {
      if (!segment || segment === '.') continue
      if (segment === '..') { if (!parts.length) return; parts.pop() }
      else parts.push(segment)
    }
    if (parts.length) void openPage({ source: current.source, name: parts.join('/') })
  }

  return <section data-testid="shared-wiki">
    <style>{markdownCSS}</style>
    <p style={{ color: '#999', 'font-size': '13px' }}>Knowledge saved across your chats.</p>
    <input type="search" aria-label="Search wiki pages" placeholder="Find a page by name or collection" value={query()} onInput={event => setQuery(event.currentTarget.value)} style={{ width: '100%', 'box-sizing': 'border-box', padding: '12px', background: '#191919', border: '1px solid #333', 'border-radius': '6px', color: '#ddd' }} />
    <nav aria-label="Wiki pages" style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '8px', padding: '16px 0', 'max-height': '180px', overflow: 'auto' }}>
      <For each={filtered()}>{page => <button onClick={() => void openPage(page)} aria-pressed={selected()?.source === page.source && selected()?.name === page.name} style={{ background: selected()?.source === page.source && selected()?.name === page.name ? '#243047' : '#191919', color: '#ddd', border: '1px solid #333', 'border-radius': '6px', padding: '9px 12px', cursor: 'pointer', 'text-align': 'left' }}>{page.name}<span style={{ display: 'block', color: '#999', 'font-size': '11px', 'margin-top': '3px' }}>{label(page.source)}</span></button>}</For>
    </nav>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <Show when={loading()}><p role="status">Loading wiki…</p></Show>
    <Show when={!loading() && !error() && !filtered().length}><p style={{ color: '#999' }}>{pages().length ? 'No matching pages.' : 'No wiki pages yet.'}</p></Show>
    <Show when={!loading() && !error() && selected()}><article class="markdown wiki-markdown" onClick={followLink} style={{ 'overflow-wrap': 'anywhere', 'line-height': '1.6' }} innerHTML={renderWikiMarkdown(content())} /></Show>
  </section>
}

function timeAgo(iso?: string | null) {
  if (!iso) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
  if (!Number.isFinite(minutes)) return ''
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

// The legacy component name preserves callers and stored Room data. The home
// itself is now chats; no Room creation or resident management is required.
export default function RoomsHome(props: {
  onOpen: (id: string) => void
  onNewChat?: () => void
  onSessionsChanged?: () => void
  view?: 'chats' | 'wiki' | 'updates'
}) {
  const [rooms, setRooms] = createSignal<RoomInfo[]>([])
  const [sessions, setSessions] = createSignal<SessionMeta[]>([])
  const [pins, setPins] = createSignal<ChatPin[]>([])
  const [archived, setArchived] = createSignal<string[]>([])
  const [showArchived, setShowArchived] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [results, setResults] = createSignal<SessionMeta[]>([])
  const [loading, setLoading] = createSignal(true)
  const [searching, setSearching] = createSignal(false)
  const [error, setError] = createSignal('')
  const [pendingPins, setPendingPins] = createSignal<string[]>([])
  const [wikiContext, setWikiContext] = createSignal('')
  const [openedWiki, setOpenedWiki] = createSignal(false)
  const [refreshKey, setRefreshKey] = createSignal(0)
  let disposed = false
  let searchGeneration = 0
  let pinsGeneration = 0
  let refreshing = false

  async function refresh() {
    if (refreshing) return
    refreshing = true
    const generation = pinsGeneration
    const responses = await Promise.allSettled([
      fetchRooms(), fetchSessions(null, undefined, 150),
      fetch(appUrl('/api/chat-pins')).then(async response => {
        if (!response.ok) throw new Error('Could not load pinned chats')
        return await response.json() as { pins: ChatPin[], archived?: string[] }
      }),
    ])
    if (disposed) return
    const [roomResponse, sessionResponse, pinResponse] = responses
    if (roomResponse.status === 'fulfilled') {
      setRooms(roomResponse.value)
    }
    if (sessionResponse.status === 'fulfilled') setSessions(sessionResponse.value.sessions)
    if (pinResponse.status === 'fulfilled' && generation === pinsGeneration) {
      setPins(pinResponse.value.pins)
      setArchived(pinResponse.value.archived || [])
    }
    const failed = responses.find(response => response.status === 'rejected')
    setError(failed?.status === 'rejected' ? String(failed.reason?.message || failed.reason) : '')
    setLoading(false)
    refreshing = false
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 15000)
    onCleanup(() => { disposed = true; clearInterval(timer); ++searchGeneration })
  })

  createEffect(() => {
    props.view
    setOpenedWiki(false)
  })

  createEffect(() => {
    const search = query().trim()
    const generation = ++searchGeneration
    if (!search) { setResults([]); setSearching(false); return }
    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        const response = await fetchSessions(null, search, 150)
        if (!disposed && generation === searchGeneration) setResults(response.sessions)
      } catch (cause) {
        if (!disposed && generation === searchGeneration) {
          setResults([])
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      } finally {
        if (!disposed && generation === searchGeneration) setSearching(false)
      }
    }, 250)
    onCleanup(() => clearTimeout(timer))
  })

  const allSessions = createMemo(() => {
    const byId = new Map<string, SessionMeta>()
    for (const room of rooms()) for (const session of room.sessions) byId.set(session.id, session)
    for (const session of sessions()) byId.set(session.id, session)
    return byId
  })
  const pinnedChats = createMemo(() => pins().filter(pin => !archived().includes(pin.id)).map(pin => {
    const session = allSessions().get(pin.id)
    return { ...session, id: pin.id, title: (pin.legacy ? pin.title : session?.title) || pin.title || 'Pinned chat', updatedAt: session?.updatedAt || '', isActive: session?.isActive || false } as SessionMeta
  }))
  const recentChats = createMemo(() => sessions().filter(session => !pins().some(pin => pin.id === session.id) && !archived().includes(session.id)))
  const archivedChats = createMemo(() => archived().map(id => allSessions().get(id) || { id, title: pins().find(pin => pin.id === id)?.title || 'Archived chat', updatedAt: '', isActive: false }))
  const searchResults = createMemo(() => results().filter(session => showArchived() || !archived().includes(session.id)))

  async function toggleArchive(session: SessionMeta) {
    if (pendingPins().includes(session.id)) return
    const shouldArchive = !archived().includes(session.id)
    ++pinsGeneration
    setPendingPins(previous => [...previous, session.id])
    try {
      const response = await fetch(appUrl(`/api/chat-pins/${encodeURIComponent(session.id)}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: shouldArchive }),
      })
      if (!response.ok) throw new Error('Could not update archived chat')
      ++pinsGeneration
      setArchived(previous => shouldArchive ? [...previous, session.id] : previous.filter(id => id !== session.id))
      props.onSessionsChanged?.()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPendingPins(previous => previous.filter(id => id !== session.id)) }
  }

  async function togglePin(session: SessionMeta) {
    if (pendingPins().includes(session.id)) return
    const pinned = !pins().some(pin => pin.id === session.id)
    ++pinsGeneration
    setPendingPins(previous => [...previous, session.id])
    try {
      const response = await fetch(appUrl(`/api/chat-pins/${encodeURIComponent(session.id)}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned, title: session.title }),
      })
      if (!response.ok) throw new Error('Could not update pinned chat')
      ++pinsGeneration
      setPins(previous => pinned ? [...previous.filter(pin => pin.id !== session.id), { id: session.id, title: session.title }] : previous.filter(pin => pin.id !== session.id))
      props.onSessionsChanged?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setPendingPins(previous => previous.filter(id => id !== session.id)) }
  }

  function ChatRow(row: { session: SessionMeta }) {
    const pinned = () => pins().some(pin => pin.id === row.session.id)
    return <div class="chat-home-row" style={{ display: 'flex', 'align-items': 'center', 'border-bottom': '1px solid #222', gap: '8px' }}>
      <button class="chat-home-open" onClick={() => props.onOpen(row.session.id)} style={{ flex: '1', 'min-width': '0', display: 'block', padding: '16px 4px', background: 'transparent', border: '0', color: '#ddd', 'text-align': 'left', cursor: 'pointer' }}>
        <span style={{ display: 'flex', gap: '10px', 'align-items': 'center' }}>
          <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'font-size': '15px', 'font-weight': '500' }}>{row.session.title || 'Untitled chat'}</span>
          <Show when={row.session.isActive}><span aria-label="Working" title="Working" style={{ width: '6px', height: '6px', background: '#72b68a', 'border-radius': '50%', 'flex-shrink': '0' }} /></Show>
          <span style={{ 'margin-left': 'auto', 'flex-shrink': '0', color: '#888', 'font-size': '11px' }}>{timeAgo(row.session.updatedAt)}</span>
        </span>
        <Show when={row.session.projectLabel}><span style={{ display: 'block', 'margin-top': '5px', color: '#999', 'font-size': '12px' }}>{row.session.projectLabel}</span></Show>
      </button>
      <button class="chat-home-pin" aria-label={`${pinned() ? 'Unpin' : 'Pin'} ${row.session.title || 'chat'}`} aria-pressed={pinned()} disabled={pendingPins().includes(row.session.id)} onClick={() => void togglePin(row.session)} style={{ padding: '10px', 'min-height': '44px', background: 'transparent', border: '0', color: pinned() ? '#a9c4ee' : '#999', cursor: 'pointer', 'font-size': '12px' }}>{pendingPins().includes(row.session.id) ? '…' : pinned() ? 'Unpin' : 'Pin'}</button>
      <button class="chat-home-control" aria-label={`${archived().includes(row.session.id) ? 'Restore' : 'Archive'} ${row.session.title || 'chat'}`} disabled={pendingPins().includes(row.session.id)} onClick={() => void toggleArchive(row.session)} style={{ padding: '8px', 'min-height': '44px', background: 'transparent', border: '0', color: '#999', cursor: 'pointer', 'font-size': '12px' }}>{archived().includes(row.session.id) ? 'Restore' : 'Archive'}</button>
    </div>
  }

  const view = () => openedWiki() ? 'wiki' : props.view || 'chats'
  return <main data-testid="chats-home" style={{ height: '100%', overflow: 'auto', background: '#111', color: '#ddd', 'font-family': 'inherit' }}>
    <style>{`.chat-home-row:hover { background: #171717; } .chat-home-open:focus-visible, .chat-home-pin:focus-visible, .chat-home-control:focus-visible { outline: 2px solid #91b9ed; outline-offset: 2px; } .chat-home-row { transition: background 120ms ease; }`}</style>
    <div style={{ width: '100%', 'max-width': '960px', margin: '0 auto', padding: '24px 18px', 'box-sizing': 'border-box' }}>
      <header style={{ display: 'flex', 'align-items': 'center', gap: '12px', 'margin-bottom': '24px' }}>
        <h1 style={{ margin: '0', 'font-size': '22px', 'font-weight': '600', flex: '1' }}>{view() === 'wiki' ? 'Wiki' : view() === 'updates' ? 'Updates' : 'Chats'}</h1>
        <button class="chat-home-control" onClick={() => { void refresh(); setRefreshKey(previous => previous + 1) }} style={{ background: 'transparent', border: '1px solid #333', 'border-radius': '6px', color: '#bbb', padding: '9px 12px', cursor: 'pointer' }}>Refresh</button>
        <Show when={props.onNewChat}><button class="chat-home-control" onClick={() => props.onNewChat?.()} style={{ background: '#d9e5f7', border: '0', 'border-radius': '6px', color: '#172233', padding: '10px 14px', 'font-weight': '600', cursor: 'pointer' }}>New chat</button></Show>
      </header>
      <Show when={error()}><p role="alert" style={{ color: '#e5a89d', 'font-size': '13px' }}>{error()}</p></Show>
      <Show when={view() === 'updates'}>
        <SuperFeed onOpenSession={props.onOpen} refreshKey={refreshKey()} onOpenRoom={name => { setWikiContext(name); setOpenedWiki(true) }} />
      </Show>
      <Show when={view() === 'wiki'}>
        <SharedWiki source={wikiContext()} refreshKey={refreshKey()} />
      </Show>
      <Show when={view() === 'chats'}>
        <input class="chat-home-control" type="search" aria-label="Search chats" placeholder="Search chats and conversations" value={query()} onInput={event => setQuery(event.currentTarget.value)} style={{ width: '100%', 'box-sizing': 'border-box', background: '#1b1b1b', border: '1px solid #333', 'border-radius': '8px', padding: '12px 14px', color: '#eee', 'font-size': '14px', 'margin-bottom': '24px' }} />
        <label style={{ display: 'flex', gap: '8px', color: '#aaa', 'font-size': '12px', 'margin-bottom': '20px' }}><input type="checkbox" checked={showArchived()} onChange={event => setShowArchived(event.currentTarget.checked)} />Show archived chats</label>
        <Show when={!query().trim()} fallback={<section aria-label="Search results"><h2 style={{ 'font-size': '13px', color: '#aaa' }}>Search results</h2><Show when={!searching()} fallback={<p role="status" style={{ color: '#999' }}>Searching…</p>}><For each={searchResults()} fallback={<p style={{ color: '#999', 'font-size': '13px' }}>No chats found.</p>}>{session => <ChatRow session={session} />}</For></Show></section>}>
          <Show when={!loading()} fallback={<p role="status" style={{ color: '#999' }}>Loading chats…</p>}>
            <section aria-label="Pinned chats" style={{ 'margin-bottom': '30px' }}>
              <h2 style={{ 'font-size': '13px', color: '#aaa', 'font-weight': '600' }}>Pinned</h2>
              <For each={pinnedChats()} fallback={<p style={{ color: '#999', 'font-size': '13px' }}>Pin a chat to keep it close.</p>}>{session => <ChatRow session={session} />}</For>
            </section>
            <Show when={showArchived()}><section aria-label="Archived chats" style={{ 'margin-top': '30px', 'margin-bottom': '30px' }}><h2 style={{ 'font-size': '13px', color: '#aaa', 'font-weight': '600' }}>Archived</h2><For each={archivedChats()} fallback={<p style={{ color: '#999', 'font-size': '13px' }}>No archived chats.</p>}>{session => <ChatRow session={session} />}</For></section></Show>
            <section aria-label="Recent chats">
              <h2 style={{ 'font-size': '13px', color: '#aaa', 'font-weight': '600' }}>Recent</h2>
              <For each={recentChats()} fallback={<p style={{ color: '#999', 'font-size': '13px' }}>Start a chat with whatever’s on your mind.</p>}>{session => <ChatRow session={session} />}</For>
            </section>
          </Show>
        </Show>
      </Show>
    </div>
  </main>
}
