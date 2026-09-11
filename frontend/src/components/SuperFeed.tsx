import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { fetchSuperFeed, postFeedComment, postRoomSteer, setFeedFollowing, FeedComment, SuperFeedItem, SuperFeedView } from '../api'
import { appUrl } from '../lib/appPath'
import { markdownCSS, renderWikiMarkdown } from './MessageView'

const views: Array<{ key: SuperFeedView, label: string }> = [
  { key: 'latest', label: 'Latest' },
  { key: 'review', label: 'Review' },
  { key: 'following', label: 'Following' },
  { key: 'friction', label: 'Friction' },
]

// Palette: every text colour passes WCAG AA on the #0d1117 card ground.
const ink = '#e6ebf2'
const body = '#c9d1dc'
const muted = '#8b97a8'
const line = '#1e2632'
const green = '#69c77f'
const amber = '#e0b45f'
const blue = '#79b8d1'
const red = '#e3826d'

function timeAgo(iso: string | null) {
  if (!iso) return ''
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

// Publications carry `#room · Title`; the room becomes a chip, so drop the prefix.
function headline(item: SuperFeedItem) {
  const prefix = `#${item.room} · `
  return item.title.startsWith(prefix) ? item.title.slice(prefix.length) : item.title
}

const SteerIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.5" /><path d="M8 2.5v4M8 9.5v4M2.5 8h4M9.5 8h4" />
  </svg>
)

const CommentIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
  </svg>
)

export function SuperFeed(props: { onOpenSession: (sessionId: string) => void, onOpenRoom?: (room: string) => void, refreshKey?: number }) {
  const [view, setView] = createSignal<SuperFeedView>('latest')
  const [items, setItems] = createSignal<SuperFeedItem[]>([])
  const [following, setFollowing] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [followBusy, setFollowBusy] = createSignal<string | null>(null)
  const [commentOpen, setCommentOpen] = createSignal<string | null>(null)
  const [commentDraft, setCommentDraft] = createSignal('')
  const [commentBusy, setCommentBusy] = createSignal(false)
  const [pendingComments, setPendingComments] = createSignal<Record<string, FeedComment[]>>({})
  const [expandedReplies, setExpandedReplies] = createSignal<Record<string, boolean>>({})
  // Steer box: one open at a time, keyed by card; `steered` remembers the receipt per card.
  const [steerOpen, setSteerOpen] = createSignal<string | null>(null)
  const [steerDraft, setSteerDraft] = createSignal('')
  const [steerBusy, setSteerBusy] = createSignal(false)
  const [steered, setSteered] = createSignal<Record<string, string>>({})

  let timer: ReturnType<typeof setInterval>
  let requestInFlight = false
  let requestController: AbortController | null = null
  let etag: string | null = null

  async function refresh() {
    if (requestInFlight) return
    requestInFlight = true
    const controller = new AbortController()
    requestController = controller
    try {
      const result = await fetchSuperFeed(etag, controller.signal)
      if (requestController !== controller) return
      etag = result.etag || etag
      if (result.snapshot) {
        setItems(result.snapshot.items)
        setFollowing(result.snapshot.following)
      }
      setError(null)
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      if (requestController === controller) {
        requestInFlight = false
        requestController = null
        setLoading(false)
      }
    }
  }

  onMount(() => {
    refresh()
    timer = setInterval(refresh, 10_000)
  })
  // Pull-to-refresh (and any other outside nudge) bumps refreshKey.
  createEffect(on(() => props.refreshKey, (key, previous) => { if (key !== undefined && key !== previous) refresh() }, { defer: true }))
  onCleanup(() => {
    clearInterval(timer)
    requestController?.abort()
  })

  const itemsFor = (selected: SuperFeedView) => {
    if (selected === 'review') return items().filter(item => item.needsReview)
    if (selected === 'following') {
      const followed = new Set(following())
      return items().filter(item => followed.has(item.room))
    }
    if (selected === 'friction') return items().filter(item => item.kind === 'friction')
    return items()
  }
  const entries = createMemo(() => itemsFor(view()))
  const countFor = (selected: SuperFeedView) => itemsFor(selected).length

  async function toggleFollowing(room: string, event: MouseEvent) {
    event.stopPropagation()
    const followed = following().includes(room)
    setFollowBusy(room)
    try {
      const next = await setFeedFollowing(room, !followed)
      setFollowing(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setFollowBusy(null)
    }
  }

  function toggleComment(item: SuperFeedItem, event: MouseEvent) {
    event.stopPropagation()
    setCommentOpen(commentOpen() === item.evidenceId ? null : item.evidenceId)
    setCommentDraft('')
  }

  async function submitComment(item: SuperFeedItem, event: Event) {
    event.preventDefault()
    event.stopPropagation()
    const text = commentDraft().trim()
    if (!text || commentBusy()) return
    setCommentBusy(true)
    try {
      const comment = await postFeedComment(item.evidenceId, text)
      setPendingComments(current => ({ ...current, [item.evidenceId]: [...(current[item.evidenceId] || []), comment] }))
      setCommentDraft('')
      setCommentOpen(null)
      setError(null)
      etag = null
      refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCommentBusy(false)
    }
  }

  function toggleSteer(item: SuperFeedItem, event: MouseEvent) {
    event.stopPropagation()
    setSteerOpen(steerOpen() === item.evidenceId ? null : item.evidenceId)
    setSteerDraft('')
  }

  async function submitSteer(item: SuperFeedItem, event: Event) {
    event.preventDefault()
    event.stopPropagation()
    const text = steerDraft().trim()
    if (!text || steerBusy()) return
    setSteerBusy(true)
    try {
      const receipt = await postRoomSteer(item.room, text)
      setSteered(current => ({ ...current, [item.evidenceId]: receipt.woke ? `Added to #${item.room} Steering · Leader woken` : `Added to #${item.room} Steering` }))
      setSteerDraft('')
      setSteerOpen(null)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSteerBusy(false)
    }
  }

  // Server comments win; pending ones show until the projection catches up.
  const commentsFor = (list: SuperFeedItem[]): FeedComment[] => {
    const out: FeedComment[] = []
    for (const item of list) {
      const server = item.comments || []
      const known = new Set(server.map(comment => comment.id))
      const pending = (pendingComments()[item.evidenceId] || []).filter(comment => !known.has(comment.id))
      out.push(...server, ...pending)
    }
    return out.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
  }

  const canOpen = (item: SuperFeedItem) => item.sourceState === 'available' && Boolean(item.sessionId)

  // The Room chip opens the Room page (mission, residents, cards, friction).
  const RoomChip = (chipProps: { room: string }) => (
    <button data-testid={`open-room-${chipProps.room}`} title={`Open #${chipProps.room}`}
      onClick={(event) => { if (props.onOpenRoom) { event.stopPropagation(); props.onOpenRoom(chipProps.room) } }}
      style={{ background: 'none', color: muted, 'font-size': '12px', 'font-weight': '700', padding: '2px 7px', border: `1px solid ${line}`, 'border-radius': '999px', 'white-space': 'nowrap', 'flex-shrink': '0', cursor: props.onOpenRoom ? 'pointer' : 'default', 'font-family': 'inherit' }}>#{chipProps.room}</button>
  )

  const Flag = (flagProps: { text: string, color: string }) => (
    <span style={{ color: flagProps.color, 'font-size': '12px', 'font-weight': '700', 'white-space': 'nowrap' }}>{flagProps.text}</span>
  )

  const FollowStar = (starProps: { item: SuperFeedItem }) => (
    <Show when={starProps.item.sourceState === 'available'}>
      <button aria-label={`${following().includes(starProps.item.room) ? 'Unfollow' : 'Follow'} #${starProps.item.room}`} data-testid={`feed-follow-${starProps.item.room}`}
        disabled={followBusy() === starProps.item.room} onClick={(event) => toggleFollowing(starProps.item.room, event)}
        style={{ background: 'none', border: 'none', color: following().includes(starProps.item.room) ? amber : muted, 'font-size': '18px', padding: '0 2px', cursor: 'pointer', 'line-height': '1', 'flex-shrink': '0' }}>
        {following().includes(starProps.item.room) ? '★' : '☆'}
      </button>
    </Show>
  )

  const MetaRow = (metaProps: { item: SuperFeedItem, flag?: { text: string, color: string } | null }) => (
    <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'min-width': '0' }}>
      <RoomChip room={metaProps.item.room} />
      <Show when={metaProps.flag}><Flag text={metaProps.flag!.text} color={metaProps.flag!.color} /></Show>
      <Show when={metaProps.item.sourceState === 'stale'}><Flag text="Source unavailable" color={red} /></Show>
      <span style={{ 'margin-left': 'auto', color: muted, 'font-size': '12px', 'font-variant-numeric': 'tabular-nums', 'white-space': 'nowrap' }}>{timeAgo(metaProps.item.occurredAt)}</span>
      <FollowStar item={metaProps.item} />
    </div>
  )

  // Comment thread under a card: the comment, the Room's answer, and the composer.
  const Thread = (threadProps: { item: SuperFeedItem, items: SuperFeedItem[] }) => {
    const list = () => commentsFor(threadProps.items)
    return (
      <div onClick={(event) => event.stopPropagation()} style={{ 'margin-top': '10px' }}>
        <Show when={list().length > 0}>
          <div style={{ display: 'grid', gap: '8px', 'margin-bottom': '8px' }}>
            <For each={list()}>{(comment) => {
              const long = () => Boolean(comment.reply && (comment.reply.text.length > 420 || comment.reply.text.split('\n').length > 6))
              const open = () => Boolean(expandedReplies()[comment.id])
              return (
                <div data-testid={`feed-comment-${comment.id}`} style={{ background: '#0a0d12', border: `1px solid ${line}`, 'border-radius': '10px', padding: '9px 11px' }}>
                  <div style={{ display: 'flex', 'align-items': 'baseline', gap: '7px', 'font-size': '12px', color: muted }}>
                    <span style={{ color: ink, 'font-weight': '700' }}>You</span>
                    <span>{timeAgo(comment.createdAt)}</span>
                  </div>
                  <div style={{ color: body, 'font-size': '14px', 'line-height': '1.5', 'margin-top': '2px', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{comment.text}</div>
                  <div style={{ 'border-top': `1px solid ${line}`, 'margin-top': '8px', 'padding-top': '8px' }}>
                    <Show when={comment.reply} fallback={
                      <div style={{ color: muted, 'font-size': '13px' }}>Sent to #{comment.room} · no answer yet</div>
                    }>
                      <div style={{ display: 'flex', 'align-items': 'baseline', gap: '7px', 'font-size': '12px', color: muted }}>
                        <span style={{ color: green, 'font-weight': '700' }}>#{comment.room}</span>
                        <span>{timeAgo(comment.reply!.timestamp)}</span>
                      </div>
                      <div class="markdown" innerHTML={renderWikiMarkdown(comment.reply!.text)}
                        style={{ color: body, 'font-size': '14px', 'margin-top': '2px', ...(long() && !open() ? { display: '-webkit-box', '-webkit-line-clamp': '6', '-webkit-box-orient': 'vertical', overflow: 'hidden' } : {}) }} />
                      <Show when={long()}>
                        <button onClick={() => setExpandedReplies(current => ({ ...current, [comment.id]: !open() }))}
                          style={{ background: 'none', border: 'none', color: muted, 'font-size': '12px', 'font-weight': '700', padding: '4px 0 0', cursor: 'pointer' }}>{open() ? 'Show less' : 'Show more'}</button>
                      </Show>
                    </Show>
                  </div>
                </div>
              )
            }}</For>
          </div>
        </Show>
        <Show when={commentOpen() === threadProps.item.evidenceId}>
          <form onSubmit={(event) => submitComment(threadProps.item, event)} style={{ display: 'flex', gap: '6px', 'align-items': 'flex-end' }}>
            <textarea data-testid={`feed-comment-input-${threadProps.item.evidenceId}`} value={commentDraft()} onInput={(event) => setCommentDraft(event.currentTarget.value)}
              placeholder={`Ask #${threadProps.item.room} about this…`} rows={2} autofocus
              onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submitComment(threadProps.item, event) }}
              style={{ flex: '1', 'min-width': '0', background: '#0b0e13', border: '1px solid #2a3442', 'border-radius': '8px', color: ink, 'font-size': '14px', padding: '8px 10px', resize: 'vertical', 'font-family': 'inherit' }} />
            <button type="submit" disabled={commentBusy() || !commentDraft().trim()}
              style={{ background: '#243044', border: 'none', color: ink, 'font-size': '13px', 'font-weight': '700', padding: '9px 13px', 'border-radius': '8px', cursor: 'pointer' }}>{commentBusy() ? '…' : 'Send'}</button>
            <button type="button" onClick={(event) => toggleComment(threadProps.item, event)}
              style={{ background: 'none', border: 'none', color: muted, 'font-size': '13px', padding: '9px 4px', cursor: 'pointer' }}>Cancel</button>
          </form>
        </Show>
      </div>
    )
  }

  // Steer box under a card: the text goes to the Room's Steering section and
  // wakes its Leader. Unlike a comment it expects no answer under the card.
  const SteerBox = (boxProps: { item: SuperFeedItem }) => (
    <div onClick={(event) => event.stopPropagation()}>
      <Show when={steered()[boxProps.item.evidenceId]}>
        <div data-testid={`feed-steer-receipt-${boxProps.item.evidenceId}`} style={{ color: green, 'font-size': '12px', 'font-weight': '700', 'margin-top': '8px' }}>{steered()[boxProps.item.evidenceId]}</div>
      </Show>
      <Show when={steerOpen() === boxProps.item.evidenceId}>
        <form onSubmit={(event) => submitSteer(boxProps.item, event)} style={{ display: 'flex', gap: '6px', 'align-items': 'flex-end', 'margin-top': '10px' }}>
          <textarea data-testid={`feed-steer-input-${boxProps.item.evidenceId}`} value={steerDraft()} onInput={(event) => setSteerDraft(event.currentTarget.value)}
            placeholder={`Steer #${boxProps.item.room}: what to do next, or differently…`} rows={2} autofocus
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submitSteer(boxProps.item, event) }}
            style={{ flex: '1', 'min-width': '0', background: '#0b0e13', border: '1px solid #2a3442', 'border-radius': '8px', color: ink, 'font-size': '14px', padding: '8px 10px', resize: 'vertical', 'font-family': 'inherit' }} />
          <button type="submit" disabled={steerBusy() || !steerDraft().trim()}
            style={{ background: '#243044', border: 'none', color: ink, 'font-size': '13px', 'font-weight': '700', padding: '9px 13px', 'border-radius': '8px', cursor: 'pointer' }}>{steerBusy() ? '…' : 'Steer'}</button>
          <button type="button" onClick={(event) => toggleSteer(boxProps.item, event)}
            style={{ background: 'none', border: 'none', color: muted, 'font-size': '13px', padding: '9px 4px', cursor: 'pointer' }}>Cancel</button>
        </form>
      </Show>
    </div>
  )

  const SteerButton = (buttonProps: { item: SuperFeedItem }) => (
    <button data-testid={`feed-steer-open-${buttonProps.item.evidenceId}`} onClick={(event) => toggleSteer(buttonProps.item, event)}
      aria-expanded={steerOpen() === buttonProps.item.evidenceId} title={`Add a line to #${buttonProps.item.room}'s Steering and wake its Leader`}
      style={{ display: 'inline-flex', 'align-items': 'center', gap: '5px', background: 'none', border: `1px solid ${line}`, 'border-radius': '999px', color: muted, 'font-size': '12px', 'font-weight': '700', padding: '4px 10px', cursor: 'pointer', 'white-space': 'nowrap' }}>
      <SteerIcon />Steer
    </button>
  )

  const CommentButton = (buttonProps: { item: SuperFeedItem, items: SuperFeedItem[] }) => {
    const count = () => commentsFor(buttonProps.items).length
    return (
      <button data-testid={`feed-comment-open-${buttonProps.item.evidenceId}`} onClick={(event) => toggleComment(buttonProps.item, event)}
        aria-expanded={commentOpen() === buttonProps.item.evidenceId}
        style={{ display: 'inline-flex', 'align-items': 'center', gap: '5px', background: 'none', border: `1px solid ${line}`, 'border-radius': '999px', color: muted, 'font-size': '12px', 'font-weight': '700', padding: '4px 10px', cursor: 'pointer', 'white-space': 'nowrap' }}>
        <CommentIcon />{count() > 0 ? `${count()} comment${count() === 1 ? '' : 's'}` : 'Comment'}
      </button>
    )
  }

  const EvidenceLink = (linkProps: { item: SuperFeedItem, label: string }) => (
    <a href={appUrl(linkProps.item.sourceHref)} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}
      style={{ color: muted, 'font-size': '12px', 'font-weight': '600', 'text-decoration': 'none', 'white-space': 'nowrap' }}>{linkProps.label}</a>
  )

  const cardStyle = (item: SuperFeedItem, clickable: boolean) => ({
    background: item.needsReview ? '#15120f' : '#0d1117',
    border: `1px solid ${item.needsReview ? '#3d2f22' : line}`,
    'border-radius': '12px',
    padding: '12px 14px',
    'min-width': '0',
    overflow: 'hidden',
    cursor: clickable ? 'pointer' : 'default',
    '-webkit-tap-highlight-color': 'transparent',
  })

  return (
    <section data-testid="super-feed" style={{ 'margin-bottom': '28px', 'font-size': '14px' }}>
      <style>{markdownCSS}</style>
      <div style={{ display: 'flex', 'align-items': 'flex-end', gap: '10px', padding: '8px 2px 12px' }}>
        <div style={{ 'min-width': '0' }}>
          <h1 style={{ margin: '0', 'font-size': '20px', 'font-weight': '700', color: ink, 'line-height': '1.2' }}>Super Feed</h1>
          <div style={{ color: muted, 'font-size': '12px', 'margin-top': '3px' }}>What shipped, what needs you, and where friction went.</div>
        </div>
        <button data-testid="feed-refresh" onClick={refresh} disabled={requestInFlight}
          style={{ 'margin-left': 'auto', background: 'none', border: `1px solid ${line}`, 'border-radius': '999px', color: muted, 'font-size': '12px', 'font-weight': '700', cursor: 'pointer', padding: '4px 10px', 'flex-shrink': '0' }}>Refresh</button>
      </div>
      <div role="tablist" aria-label="Super Feed views" style={{ display: 'grid', 'grid-template-columns': 'repeat(4, 1fr)', gap: '4px', padding: '3px', background: '#0b0e13', border: `1px solid ${line}`, 'border-radius': '11px', 'margin-bottom': '10px' }}>
        <For each={views}>{(option) => (
          <button role="tab" aria-selected={view() === option.key} data-testid={`feed-tab-${option.key}`} onClick={() => setView(option.key)}
            style={{ border: 'none', background: view() === option.key ? '#202938' : 'transparent', color: view() === option.key ? ink : muted, padding: '8px 4px', 'border-radius': '8px', 'font-size': '12px', 'font-weight': '700', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
            {option.label}<Show when={countFor(option.key) > 0}><span style={{ color: view() === option.key ? '#aeb9c8' : '#6c7889', 'font-weight': '600' }}> {countFor(option.key)}</span></Show>
          </button>
        )}</For>
      </div>

      <Show when={error()}>
        <div style={{ color: red, 'font-size': '13px', padding: '8px 4px' }}>{error()}</div>
      </Show>
      <Show when={loading()}>
        <div style={{ color: muted, 'text-align': 'center', padding: '26px 8px', 'font-size': '14px' }}>Loading your feed…</div>
      </Show>
      <Show when={!loading() && entries().length === 0}>
        <div data-testid="feed-empty" style={{ color: muted, 'text-align': 'center', padding: '26px 12px', background: '#0d1117', border: `1px solid ${line}`, 'border-radius': '12px', 'font-size': '14px', 'line-height': '1.5' }}>
          {view() === 'following' ? 'Nothing from followed Rooms yet. Follow a Room from Latest.' : view() === 'review' ? 'Nothing needs your review.' : view() === 'friction' ? 'No friction has been reported.' : 'Nothing published yet. Rooms post here when they have something worth your time.'}
        </div>
      </Show>

      <div style={{ display: 'grid', gap: '10px' }}>
        <For each={entries()}>{(item) => {
          if (item.kind === 'friction') {
            return (
              <article data-testid={`feed-item-${item.evidenceId}`} style={cardStyle(item, false)}>
                <MetaRow item={item} flag={item.resolvedAt ? { text: 'Resolved', color: green } : { text: 'Friction', color: amber }} />
                <div class="markdown" innerHTML={renderWikiMarkdown(item.summary)} style={{ color: item.resolvedAt ? body : ink, 'font-size': '15px', 'font-weight': '600', 'margin-top': '7px' }} />
                <Show when={item.detail}>
                  <div class="markdown" innerHTML={renderWikiMarkdown(item.detail!)} style={{ color: body, 'font-size': '13px', 'margin-top': '6px' }} />
                </Show>
                <Show when={item.resolvedAt}>
                  <div data-testid={`resolved-${item.complaintId}`} style={{ 'margin-top': '8px', padding: '7px 10px', 'border-left': `2px solid ${green}`, background: '#0f1a14', color: body, 'font-size': '13px', 'line-height': '1.45' }}>
                    <span style={{ color: green, 'font-weight': '700' }}>Resolved</span>{item.resolution ? ` · ${item.resolution}` : ''}
                  </div>
                </Show>
                <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'margin-top': '9px', 'min-width': '0' }}>
                  <Show when={item.sourceState === 'available'}><EvidenceLink item={item} label="Canonical evidence ↗" /></Show>
                  <span style={{ 'margin-left': 'auto', color: muted, 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace", overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{item.complaintId}</span>
                </div>
              </article>
            )
          }
          if (item.sourceKind) {
            return <article data-testid={`feed-item-${item.evidenceId}`} style={cardStyle(item, false)}>
              <div style={{ color: muted, 'font-size': '12px' }}>{item.sourceKind === 'wiki' ? 'Shared wiki' : item.room} · {timeAgo(item.occurredAt)}</div>
              <h3 style={{ color: ink, 'font-size': '16px', 'word-break': 'break-word' }}>{item.title}</h3>
              <div class="markdown" innerHTML={renderWikiMarkdown(item.summary)} style={{ color: body, 'font-size': '14px' }} />
              <a href={appUrl(item.sourceHref)} onClick={event => {
                if (item.sourceKind === 'chat' && item.sessionId && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                  event.preventDefault(); props.onOpenSession(item.sessionId)
                }
              }} style={{ color: green, 'font-size': '13px' }}>Open {item.sourceKind === 'wiki' ? 'Wiki' : 'chat'} →</a>
            </article>
          }
          if (item.publicationId) {
            // Publication: visual on top, headline, summary, details folded, comments.
            return (
              <article data-testid={`feed-item-${item.evidenceId}`} style={cardStyle(item, false)}>
                <Show when={item.visualHref && item.visualAlt}>
                  <img src={appUrl(item.visualHref!)} alt={item.visualAlt!} loading="lazy"
                    style={{ display: 'block', width: '100%', 'aspect-ratio': '16 / 9', 'object-fit': 'cover', 'margin-bottom': '10px', 'border-radius': '9px', border: '1px solid #202938', background: '#080b10' }} />
                </Show>
                <MetaRow item={item} flag={item.attention === 'by-the-way'
                  ? { text: 'By the way', color: blue }
                  : { text: 'Briefing', color: green }} />
                <h3 style={{ margin: '8px 0 0', color: ink, 'font-size': '16px', 'font-weight': '700', 'line-height': '1.3', 'word-break': 'break-word' }}>{headline(item)}</h3>
                <div class="markdown" innerHTML={renderWikiMarkdown(item.summary)} style={{ color: body, 'font-size': '14px', 'margin-top': '6px' }} />
                <Show when={item.detail}>
                  <div data-testid={`feed-detail-${item.evidenceId}`} class="markdown" innerHTML={renderWikiMarkdown(item.detail!)}
                    style={{ color: body, 'font-size': '13px', 'margin-top': '8px', 'padding-top': '8px', 'border-top': `1px solid ${line}` }} />
                </Show>
                <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'margin-top': '10px', 'flex-wrap': 'wrap' }}>
                  <Show when={item.sourceState === 'available'}><CommentButton item={item} items={[item]} /></Show>
                  <Show when={item.sourceState === 'available'}><SteerButton item={item} /></Show>
                  <span style={{ 'margin-left': 'auto', display: 'inline-flex', gap: '10px', 'align-items': 'center' }}>
                    <Show when={item.sourceState === 'available' && item.wikiPage}>
                      <a data-testid={`feed-wiki-${item.evidenceId}`} href={`#room/${encodeURIComponent(item.room)}/wiki/${encodeURIComponent(item.wikiPage!)}`} onClick={(event) => event.stopPropagation()}
                        style={{ color: green, 'font-size': '12px', 'font-weight': '700', 'text-decoration': 'none', 'white-space': 'nowrap' }}>Read the page →</a>
                    </Show>
                    <Show when={item.sourceState === 'available'}><EvidenceLink item={item} label="Published evidence ↗" /></Show>
                  </span>
                </div>
                <Show when={item.sourceState === 'available'}><SteerBox item={item} /></Show>
                <Show when={item.sourceState === 'available'}><Thread item={item} items={[item]} /></Show>
              </article>
            )
          }
          // Alerts and anything else that needs review.
          return (
            <article data-testid={`feed-item-${item.evidenceId}`} onClick={() => { if (canOpen(item)) props.onOpenSession(item.sessionId!) }} style={cardStyle(item, canOpen(item))}>
              <MetaRow item={item} flag={item.needsReview ? { text: 'Needs review', color: red } : null} />
              <div style={{ color: ink, 'font-size': '15px', 'font-weight': '600', 'margin-top': '7px', 'word-break': 'break-word' }}>{headline(item)}</div>
              <div class="markdown" innerHTML={renderWikiMarkdown(item.summary)} style={{ color: body, 'font-size': '14px', 'margin-top': '4px' }} />
              <Show when={item.detail}>
                <div style={{ color: muted, 'font-size': '13px', 'line-height': '1.45', 'margin-top': '4px', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{item.detail}</div>
              </Show>
              <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'margin-top': '9px' }}>
                <Show when={item.sourceState === 'available'}><CommentButton item={item} items={[item]} /></Show>
              </div>
              <Show when={item.sourceState === 'available'}><Thread item={item} items={[item]} /></Show>
            </article>
          )
        }}</For>
      </div>
    </section>
  )
}
