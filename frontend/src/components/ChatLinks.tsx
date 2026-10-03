import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js'
import { fetchChatLinks, removeChatLink, reorderChatLinks, type ChatLink } from '../api'
import { fileKind, loadFileText, previewDocument } from './FilePreview'
import { markdownCSS } from './MessageView'
import { localFileUrl } from '../lib/localMedia.js'
import { linkTarget } from '../lib/linkTarget.js'
import './ChatLinks.css'

// Agents add links as they work; poll while the tab is open so new links and
// front-page edits show up without a reload.
const POLL_MS = 4000

function timeAgo(ms?: number) {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function openWeb(href: string) { window.open(href, '_blank', 'noopener,noreferrer') }

// The front page renders inline with the file viewer's locked-down preview and
// reloads when the file's mtime changes, keeping the old view until then.
function FrontPage(props: { link: ChatLink, onOpen: (path: string) => void }) {
  const [content, setContent] = createSignal('')
  const [error, setError] = createSignal('')
  const [ready, setReady] = createSignal(false)
  const kind = () => fileKind(props.link.target)
  const baseDir = () => props.link.target.slice(0, props.link.target.lastIndexOf('/'))
  const versioned = () => `${localFileUrl(props.link.target)}&v=${props.link.mtimeMs || 0}`
  createEffect(on([() => props.link.target, () => props.link.mtimeMs, () => props.link.missing], ([target, , missing]) => {
    if (missing) { setError('The front page file is missing. The chat may not have written it yet.'); setReady(false); return }
    if (!['md', 'html', 'text'].includes(fileKind(target))) { setError(''); setReady(true); return }
    const controller = new AbortController()
    loadFileText(versioned(), controller.signal, { cache: 'no-store' })
      .then(text => { setContent(text); setError(''); setReady(true) })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) })
    onCleanup(() => controller.abort())
  }))
  function follow(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest('a'); if (!a) return
    const target = linkTarget(a.getAttribute('href'), baseDir())
    e.preventDefault()
    if (target.kind === 'file') props.onOpen(target.path + (target.line ? ':' + target.line : ''))
    else if (target.kind === 'web') openWeb(target.href)
  }
  return <section class="chat-front" aria-label="Front page" data-testid="chat-front-page">
    <style>{markdownCSS}</style>
    <header>
      <div><strong>{props.link.label}</strong><span>Front page<Show when={props.link.mtimeMs}> · updated {timeAgo(props.link.mtimeMs)}</Show></span></div>
      <button class="chat-links-action" onClick={() => props.onOpen(props.link.target)}>Open</button>
    </header>
    <Show when={error()}><p role="alert" class="chat-links-error">{error()}</p></Show>
    <Show when={ready()}>
      <Show when={kind() === 'html'}><iframe title={`${props.link.label} front page`} sandbox="" referrerpolicy="no-referrer" srcdoc={previewDocument('html', content(), baseDir())} /></Show>
      <Show when={kind() === 'md'}><article class="markdown chat-front-markdown" onClick={follow} innerHTML={previewDocument('md', content(), baseDir())} /></Show>
      <Show when={kind() === 'image'}><img class="chat-front-image" src={versioned()} alt={props.link.label} /></Show>
      <Show when={kind() === 'text'}><pre class="chat-front-text">{content()}</pre></Show>
      <Show when={['pdf', 'video', 'audio'].includes(kind())}><p class="chat-links-empty">This file opens in the file viewer.</p></Show>
    </Show>
  </section>
}

export function ChatLinks(props: { sessionId: string, active: boolean, onOpenFile: (path: string) => void }) {
  const [links, setLinks] = createSignal<ChatLink[] | null>(null)
  const [error, setError] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  let generation = 0
  async function load() {
    const id = props.sessionId, mine = ++generation
    try {
      const next = await fetchChatLinks(id)
      // Keep the same objects when nothing changed so rows and the front page stay mounted.
      if (mine === generation && id === props.sessionId) { if (JSON.stringify(next) !== JSON.stringify(links())) setLinks(next); setError('') }
    } catch (e) { if (mine === generation) setError(e instanceof Error ? e.message : String(e)) }
  }
  createEffect(on(() => props.sessionId, () => { generation++; setLinks(null); setError('') }))
  createEffect(() => {
    if (!props.active) return
    props.sessionId
    void load()
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && !busy()) void load() }, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    onCleanup(() => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) })
  })
  async function change(run: () => Promise<ChatLink[]>) {
    setBusy(true); generation++
    try { setLinks(await run()); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); void load() }
    finally { setBusy(false) }
  }
  function move(index: number, delta: number) {
    const order = (links() || []).map(link => link.target)
    const [item] = order.splice(index, 1)
    order.splice(index + delta, 0, item)
    void change(() => reorderChatLinks(props.sessionId, order))
  }
  function remove(link: ChatLink) {
    if (!confirm(`Remove “${link.label}” from this chat's links?${link.front ? '\n\nIt is the front page.' : ''}`)) return
    void change(() => removeChatLink(props.sessionId, link.target))
  }
  function open(link: ChatLink) {
    if (link.kind === 'web') openWeb(link.target)
    else props.onOpenFile(link.target)
  }
  const front = () => links()?.find(link => link.front)
  return <div class="chat-links" data-testid="chat-links">
    <div class="chat-links-content">
      <Show when={error()}><p role="alert" class="chat-links-error">{error()}</p></Show>
      <Show when={links() === null && !error()}><p role="status" class="chat-links-empty">Loading links…</p></Show>
      <Show when={front()}>{link => <FrontPage link={link()} onOpen={props.onOpenFile} />}</Show>
      <Show when={links()}>{list => <section aria-label="Links">
        <h2>Links</h2>
        <For each={list()} fallback={<p class="chat-links-empty">No links yet. When this chat makes files or pages worth opening again, they appear here.</p>}>{(link, index) =>
          <div class="chat-links-row" data-testid="chat-link">
            <button class="chat-links-open" onClick={() => open(link)} title={link.target}>
              <span class="chat-links-label">{link.label}<Show when={link.front}><span class="chat-links-badge">Front page</span></Show></span>
              <span class="chat-links-target">{link.kind === 'web' ? link.target.replace(/^https?:\/\//, '') : link.target}<Show when={link.missing}> · missing</Show></span>
            </button>
            <button class="chat-links-action" aria-label={`Move ${link.label} up`} disabled={busy() || index() === 0} onClick={() => move(index(), -1)}>↑</button>
            <button class="chat-links-action" aria-label={`Move ${link.label} down`} disabled={busy() || index() === list().length - 1} onClick={() => move(index(), 1)}>↓</button>
            <button class="chat-links-action" aria-label={`Remove ${link.label}`} disabled={busy()} onClick={() => remove(link)}>Remove</button>
          </div>}
        </For>
      </section>}</Show>
    </div>
  </div>
}
