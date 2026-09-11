import { createEffect, createMemo, createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { fetchRooms, fetchSessions, RoomInfo, SessionMeta } from './api'
import { appUrl } from './lib/appPath.js'
import { markdownCSS, renderWikiMarkdown } from './components/MessageView'
import { SuperFeed } from './components/SuperFeed'
import './workspace.css'

type ChatPin = { id: string, title?: string, legacy?: boolean }
type WikiPage = { source: string, name: string, size: number, updatedAt: string }

function lastUsedFirst(a: SessionMeta, b: SessionMeta) {
  return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
}

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

  return <section data-testid="shared-wiki" class="workspace-wiki">
    <style>{markdownCSS}</style>
    <div class="workspace-wiki-index">
      <input class="workspace-search" type="search" aria-label="Search wiki pages" placeholder="Find a page or collection" value={query()} onInput={event => setQuery(event.currentTarget.value)} />
      <nav aria-label="Wiki pages" class="workspace-wiki-pages">
        <For each={filtered()}>{page => <button class="workspace-wiki-page" onClick={() => void openPage(page)} aria-pressed={selected()?.source === page.source && selected()?.name === page.name}>{page.name}<span>{label(page.source)}</span></button>}</For>
      </nav>
      <Show when={!loading() && !error() && !filtered().length}><p class="workspace-empty">{pages().length ? 'No matching pages.' : 'No wiki pages yet.'}</p></Show>
    </div>
    <div class="workspace-wiki-reading">
      <Show when={error()}><p role="alert" class="workspace-error">{error()}</p></Show>
      <Show when={loading()}><p role="status" class="workspace-empty">Loading wiki…</p></Show>
      <Show when={!loading() && !error() && selected()}><article class="markdown wiki-markdown" onClick={followLink} innerHTML={renderWikiMarkdown(content())} /></Show>
    </div>
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
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const response = await fetchSessions(null, search, 150, undefined, { signal: controller.signal })
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
    onCleanup(() => { clearTimeout(timer); controller.abort() })
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
  }).sort(lastUsedFirst))
  const recentChats = createMemo(() => sessions().filter(session => !pins().some(pin => pin.id === session.id) && !archived().includes(session.id)).sort(lastUsedFirst))
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
    return <div class="chat-home-row">
      <button class="chat-home-open" onClick={() => props.onOpen(row.session.id)}>
        <span class="chat-home-title-line">
          <span class="chat-home-title">{row.session.title || 'Untitled chat'}</span>
          <Show when={row.session.isActive}><span class="chat-home-working" aria-label="Working" title="Working" /></Show>
          <span class="chat-home-time">{timeAgo(row.session.updatedAt)}</span>
        </span>
        <Show when={row.session.projectLabel}><span class="chat-home-project">{row.session.projectLabel}</span></Show>
      </button>
      <button class="chat-home-pin chat-home-action" aria-label={`${pinned() ? 'Unpin' : 'Pin'} ${row.session.title || 'chat'}`} aria-pressed={pinned()} disabled={pendingPins().includes(row.session.id)} onClick={() => void togglePin(row.session)}>{pendingPins().includes(row.session.id) ? '…' : pinned() ? 'Unpin' : 'Pin'}</button>
      <button class="chat-home-control chat-home-action" aria-label={`${archived().includes(row.session.id) ? 'Restore' : 'Archive'} ${row.session.title || 'chat'}`} disabled={pendingPins().includes(row.session.id)} onClick={() => void toggleArchive(row.session)}>{archived().includes(row.session.id) ? 'Restore' : 'Archive'}</button>
    </div>
  }

  const view = () => openedWiki() ? 'wiki' : props.view || 'chats'
  return <main data-testid="chats-home" class="workspace-home">
    <div class="workspace-content">
      <header class="workspace-header">
        <div class="workspace-heading"><h1>{view() === 'wiki' ? 'Wiki' : view() === 'updates' ? 'Updates' : 'Chats'}</h1><p>{view() === 'wiki' ? 'Knowledge saved across your chats.' : view() === 'updates' ? 'The latest from your work.' : 'Pick up where you left off.'}</p></div>
        <div class="workspace-header-actions">
          <button class="chat-home-control workspace-button" onClick={() => { void refresh(); setRefreshKey(previous => previous + 1) }}>Refresh</button>
          <Show when={props.onNewChat}><button class="chat-home-control workspace-button workspace-button-primary" onClick={() => props.onNewChat?.()}>New chat</button></Show>
        </div>
      </header>
      <Show when={error()}><p role="alert" class="workspace-error">{error()}</p></Show>
      <Show when={view() === 'updates'}>
        <SuperFeed onOpenSession={props.onOpen} refreshKey={refreshKey()} onOpenRoom={name => { setWikiContext(name); setOpenedWiki(true) }} />
      </Show>
      <Show when={view() === 'wiki'}>
        <SharedWiki source={wikiContext()} refreshKey={refreshKey()} />
      </Show>
      <Show when={view() === 'chats'}>
        <div class="workspace-search-bar">
          <input class="chat-home-control workspace-search" type="search" aria-label="Search chats" placeholder="Search chats and conversations" value={query()} onInput={event => setQuery(event.currentTarget.value)} />
          <label class="workspace-archive-toggle"><input type="checkbox" checked={showArchived()} onChange={event => setShowArchived(event.currentTarget.checked)} />Show archived chats</label>
        </div>
        <Show when={!query().trim()} fallback={<section aria-label="Search results" class="workspace-section"><h2>Search results</h2><Show when={!searching()} fallback={<p role="status" class="workspace-empty">Searching…</p>}><For each={searchResults()} fallback={<p class="workspace-empty">No chats found.</p>}>{session => <ChatRow session={session} />}</For></Show></section>}>
          <Show when={!loading()} fallback={<p role="status" class="workspace-empty">Loading chats…</p>}>
            <section aria-label="Pinned chats" class="workspace-section">
              <h2>Pinned<span class="workspace-count" aria-hidden="true">{pinnedChats().length}</span></h2>
              <For each={pinnedChats()} fallback={<p class="workspace-empty">Pin a chat to keep it close.</p>}>{session => <ChatRow session={session} />}</For>
            </section>
            <Show when={showArchived()}><section aria-label="Archived chats" class="workspace-section"><h2>Archived<span class="workspace-count" aria-hidden="true">{archivedChats().length}</span></h2><For each={archivedChats()} fallback={<p class="workspace-empty">No archived chats.</p>}>{session => <ChatRow session={session} />}</For></section></Show>
            <section aria-label="Recent chats" class="workspace-section">
              <h2>Recent</h2>
              <For each={recentChats()} fallback={<p class="workspace-empty">Start a chat with whatever’s on your mind.</p>}>{session => <ChatRow session={session} />}</For>
            </section>
          </Show>
        </Show>
      </Show>
    </div>
  </main>
}
