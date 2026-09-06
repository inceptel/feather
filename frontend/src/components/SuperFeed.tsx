import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { fetchSuperFeed, postFeedComment, setFeedFollowing, FeedComment, SuperFeedItem, SuperFeedView } from '../api'
import { appUrl } from '../lib/appPath'

const views: Array<{ key: SuperFeedView, label: string }> = [
  { key: 'latest', label: 'Latest' },
  { key: 'review', label: 'Review' },
  { key: 'following', label: 'Following' },
  { key: 'friction', label: 'Friction' },
]

function timeAgo(iso: string | null) {
  if (!iso) return ''
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function statusColor(item: SuperFeedItem) {
  if (item.kind === 'friction') return '#d5a85d'
  if (item.needsReview) return '#df7861'
  if (item.status === 'working') return '#69c77f'
  return '#8190a4'
}

export function SuperFeed(props: { onOpenSession: (sessionId: string) => void }) {
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
  onCleanup(() => {
    clearInterval(timer)
    requestController?.abort()
  })

  const visibleItems = createMemo(() => {
    const selected = view()
    if (selected === 'review') return items().filter(item => item.needsReview)
    if (selected === 'following') {
      const followed = new Set(following())
      return items().filter(item => followed.has(item.room))
    }
    if (selected === 'friction') return items().filter(item => item.kind === 'friction')
    return items()
  })

  const countFor = (selected: SuperFeedView) => {
    if (selected === 'review') return items().filter(item => item.needsReview).length
    if (selected === 'following') {
      const followed = new Set(following())
      return items().filter(item => followed.has(item.room)).length
    }
    if (selected === 'friction') return items().filter(item => item.kind === 'friction').length
    return items().length
  }

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
      setError(null)
      etag = null
      refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCommentBusy(false)
    }
  }

  // Server comments win; pending ones show until the projection catches up.
  const commentsFor = (item: SuperFeedItem): FeedComment[] => {
    const server = item.comments || []
    const known = new Set(server.map(comment => comment.id))
    const pending = (pendingComments()[item.evidenceId] || []).filter(comment => !known.has(comment.id))
    return [...server, ...pending]
  }

  return (
    <section data-testid="super-feed" style={{ 'margin-bottom': '24px' }}>
      <div style={{ display: 'flex', 'justify-content': 'flex-end', 'margin-bottom': '5px' }}>
        <button data-testid="feed-refresh" onClick={refresh} disabled={requestInFlight}
          style={{ background: 'none', border: 'none', color: '#6f7b8c', 'font-size': '10px', cursor: 'pointer', padding: '2px 3px' }}>Refresh</button>
      </div>
      <div role="tablist" aria-label="Super Feed views" style={{ display: 'grid', 'grid-template-columns': 'repeat(4, 1fr)', gap: '4px', padding: '3px', background: '#0b0e13', border: '1px solid #1e2632', 'border-radius': '11px', 'margin-bottom': '10px' }}>
        <For each={views}>{(option) => (
          <button role="tab" aria-selected={view() === option.key} data-testid={`feed-tab-${option.key}`} onClick={() => setView(option.key)}
            style={{ border: 'none', background: view() === option.key ? '#202938' : 'transparent', color: view() === option.key ? '#f0f3f8' : '#7f8998', padding: '8px 4px', 'border-radius': '8px', 'font-size': '11px', 'font-weight': '700', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>
            {option.label}<Show when={countFor(option.key) > 0}><span style={{ color: view() === option.key ? '#aeb9c8' : '#596474', 'font-weight': '600' }}> {countFor(option.key)}</span></Show>
          </button>
        )}</For>
      </div>

      <Show when={error()}>
        <div style={{ color: '#df7861', 'font-size': '12px', padding: '8px 4px' }}>{error()}</div>
      </Show>
      <Show when={loading()}>
        <div style={{ color: '#667080', 'text-align': 'center', padding: '26px 8px', 'font-size': '13px' }}>Loading your feed…</div>
      </Show>
      <Show when={!loading() && visibleItems().length === 0}>
        <div data-testid="feed-empty" style={{ color: '#667080', 'text-align': 'center', padding: '26px 12px', background: '#0d1117', border: '1px solid #1e2632', 'border-radius': '12px', 'font-size': '13px', 'line-height': '1.5' }}>
          {view() === 'following' ? 'Nothing from followed Rooms yet. Follow a Room from Latest.' : view() === 'review' ? 'Nothing needs your review.' : view() === 'friction' ? 'No friction has been reported.' : 'No Room updates yet.'}
        </div>
      </Show>

      <div style={{ display: 'grid', gap: '8px' }}>
        <For each={visibleItems()}>{(item) => (
          <article data-testid={`feed-item-${item.evidenceId}`}
            onClick={() => { if (item.sourceState === 'available' && item.sessionId) props.onOpenSession(item.sessionId) }}
            style={{ background: item.needsReview ? '#15120f' : '#0d1117', border: `1px solid ${item.needsReview ? '#382b20' : '#1e2632'}`, 'border-radius': '12px', padding: '12px 13px', 'min-width': '0', overflow: 'hidden', cursor: item.sourceState === 'available' && item.sessionId ? 'pointer' : 'default', '-webkit-tap-highlight-color': 'transparent' }}>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '7px' }}>
              <span style={{ width: '7px', height: '7px', 'border-radius': '50%', background: statusColor(item), 'flex-shrink': '0' }} />
              <strong style={{ color: '#e2e7ee', 'font-size': '13px', 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{item.title}</strong>
              <Show when={item.status}>
                <span style={{ color: statusColor(item), 'font-size': '9px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.06em' }}>{item.status}</span>
              </Show>
              <Show when={item.sourceState === 'stale'}>
                <span style={{ color: '#df7861', 'font-size': '9px', 'font-weight': '700', 'text-transform': 'uppercase' }}>source unavailable</span>
              </Show>
              <span style={{ 'margin-left': 'auto', color: '#596474', 'font-size': '10px', 'font-family': 'monospace' }}>{timeAgo(item.occurredAt)}</span>
              <Show when={item.sourceState === 'available'}>
                <button aria-label={`${following().includes(item.room) ? 'Unfollow' : 'Follow'} #${item.room}`} data-testid={`feed-follow-${item.room}`} disabled={followBusy() === item.room} onClick={(event) => toggleFollowing(item.room, event)}
                  style={{ background: 'none', border: 'none', color: following().includes(item.room) ? '#e0b45f' : '#596474', 'font-size': '17px', padding: '0 2px', cursor: 'pointer', 'line-height': '1' }}>
                  {following().includes(item.room) ? '★' : '☆'}
                </button>
              </Show>
            </div>
            <div style={{ color: '#bdc5d0', 'font-size': '13px', 'line-height': '1.45', 'margin-top': '7px', 'white-space': 'pre-wrap', 'word-break': 'break-word', display: '-webkit-box', '-webkit-line-clamp': '4', '-webkit-box-orient': 'vertical', overflow: 'hidden' }}>{item.summary}</div>
            <Show when={item.detail}>
              <div style={{ color: '#788495', 'font-size': '11px', 'line-height': '1.4', 'margin-top': '6px', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>{item.detail}</div>
            </Show>
            <Show when={item.visualHref && item.visualAlt}>
              <img src={appUrl(item.visualHref!)} alt={item.visualAlt!} loading="lazy"
                style={{ display: 'block', width: '100%', 'max-height': '320px', 'object-fit': 'cover', 'margin-top': '9px', 'border-radius': '9px', border: '1px solid #202938', background: '#080b10' }} />
            </Show>
            <Show when={item.publicationId && item.sourceState === 'available'}>
              <a href={appUrl(item.sourceHref)} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}
                style={{ display: 'inline-block', color: '#8d9bae', 'font-size': '10px', 'margin-top': '7px', 'text-decoration': 'none' }}>Published evidence ↗</a>
            </Show>
            <Show when={item.complaintId}>
              <div style={{ color: '#665b4b', 'font-size': '9px', 'font-family': 'monospace', 'margin-top': '7px' }}>{item.complaintId}</div>
            </Show>
            <Show when={item.kind !== 'friction' && item.sourceState === 'available'}>
              <div onClick={(event) => event.stopPropagation()} style={{ 'margin-top': '9px' }}>
                <For each={commentsFor(item)}>{(comment) => (
                  <div data-testid={`feed-comment-${comment.id}`} style={{ 'border-left': '2px solid #2a3442', padding: '4px 0 4px 9px', 'margin-bottom': '6px' }}>
                    <div style={{ color: '#d5dbe4', 'font-size': '12px', 'line-height': '1.4', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>
                      <span style={{ color: '#8190a4', 'font-size': '10px', 'font-weight': '700', 'margin-right': '6px' }}>YOU</span>{comment.text}
                    </div>
                    <Show when={comment.reply} fallback={<div style={{ color: '#667080', 'font-size': '10px', 'margin-top': '3px' }}>#{comment.room} is answering…</div>}>
                      <div style={{ color: '#bdc5d0', 'font-size': '12px', 'line-height': '1.45', 'margin-top': '5px', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>
                        <span style={{ color: '#69c77f', 'font-size': '10px', 'font-weight': '700', 'margin-right': '6px' }}>#{comment.room.toUpperCase()}</span>{comment.reply!.text}
                      </div>
                    </Show>
                  </div>
                )}</For>
                <Show when={commentOpen() === item.evidenceId} fallback={
                  <button data-testid={`feed-comment-open-${item.evidenceId}`} onClick={(event) => toggleComment(item, event)}
                    style={{ background: 'none', border: 'none', color: '#8d9bae', 'font-size': '11px', padding: '2px 0', cursor: 'pointer' }}>Comment</button>
                }>
                  <form onSubmit={(event) => submitComment(item, event)} style={{ display: 'flex', gap: '6px', 'align-items': 'flex-end' }}>
                    <textarea data-testid={`feed-comment-input-${item.evidenceId}`} value={commentDraft()} onInput={(event) => setCommentDraft(event.currentTarget.value)}
                      placeholder={`Ask #${item.room} about this…`} rows={2} autofocus
                      onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submitComment(item, event) }}
                      style={{ flex: '1', background: '#0b0e13', border: '1px solid #2a3442', 'border-radius': '8px', color: '#e2e7ee', 'font-size': '13px', padding: '7px 9px', resize: 'vertical', 'font-family': 'inherit' }} />
                    <button type="submit" disabled={commentBusy() || !commentDraft().trim()}
                      style={{ background: '#202938', border: 'none', color: '#f0f3f8', 'font-size': '12px', 'font-weight': '700', padding: '8px 12px', 'border-radius': '8px', cursor: 'pointer' }}>{commentBusy() ? '…' : 'Send'}</button>
                    <button type="button" onClick={(event) => toggleComment(item, event)}
                      style={{ background: 'none', border: 'none', color: '#7f8998', 'font-size': '12px', padding: '8px 4px', cursor: 'pointer' }}>Cancel</button>
                  </form>
                </Show>
              </div>
            </Show>
            <Show when={item.kind === 'friction' && item.sourceState === 'available'}>
              <a href={appUrl(item.sourceHref)} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}
                style={{ display: 'inline-block', color: '#8d9bae', 'font-size': '10px', 'margin-top': '7px', 'text-decoration': 'none' }}>Canonical evidence ↗</a>
            </Show>
          </article>
        )}</For>
      </div>
    </section>
  )
}
