import { For, Show, createEffect, createSignal, on, onCleanup } from 'solid-js'
import type { Message, ContentBlock } from '../api'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'

// ── Markdown renderer with LRU cache ────────────────────────────────────────

const marked = new Marked({ gfm: true, breaks: true })
const mdCache = new Map<string, string>()
const MD_CACHE_MAX = 2000
const STRIP_TAGS = ['local-command-caveat', 'command-name', 'command-message', 'command-args', 'persisted-output']

function stripInternalTags(text: string): string {
  let cleaned = text
  for (const tag of STRIP_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '')
  }
  return cleaned.trim()
}

function renderMarkdown(text: string): string {
  const cleaned = stripInternalTags(text)
  const cached = mdCache.get(cleaned)
  if (cached !== undefined) return cached
  const html = marked.parse(cleaned) as string
  const safe = DOMPurify.sanitize(html)
  if (mdCache.size >= MD_CACHE_MAX) {
    const first = mdCache.keys().next().value!
    mdCache.delete(first)
  }
  mdCache.set(cleaned, safe)
  return safe
}

function stripAnsi(text: string): string {
  return text.replace(
    /(?:\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[P^_][\s\S]*?\u001b\\|\u001b[@-_])/g,
    '',
  )
}

// ── Tool rendering ──────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  Read: '📄', Write: '✏️', Edit: '✂️', Bash: '⚡', Grep: '🔍', Glob: '🗂️',
  WebFetch: '🌐', WebSearch: '🔎', Agent: '🤖', Skill: '⚡',
}

const TOOL_COLORS: Record<string, string> = {
  Bash: '#e5946b', Read: '#73b8ff', Write: '#4aba6a', Edit: '#c4993a',
  Grep: '#b48ead', Glob: '#88c0d0', WebFetch: '#88c0d0', WebSearch: '#b48ead',
  Agent: '#73b8ff', Skill: '#b48ead',
}

function toolSummary(name: string, input: any): string {
  if (!input) return ''
  const fp = input.file_path as string || ''
  const short = fp.split('/').slice(-2).join('/')
  switch (name) {
    case 'Read': return short + (input.offset ? ` L${input.offset}` : '')
    case 'Write': return short
    case 'Edit': return short + (input.replace_all ? ' ×all' : '')
    case 'Bash': { const c = (input.command || '').split('\n')[0].trim(); return c.length > 80 ? c.slice(0, 80) + '…' : c }
    case 'Grep': return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`
    case 'Glob': return input.pattern || ''
    case 'Agent': return input.description || ''
    default: return ''
  }
}

// ── Block renderers ─────────────────────────────────────────────────────────

function renderBlock(block: ContentBlock) {
  if (block.type === 'text' && block.text) {
    return <div class="markdown" innerHTML={renderMarkdown(block.text)} />
  }
  if (block.type === 'thinking' && block.thinking) {
    return (
      <details style={{ margin: '4px 0' }}>
        <summary style={{ color: '#c4993a', 'font-size': '12px', cursor: 'pointer' }}>Thinking...</summary>
        <div style={{ color: '#c9d1d9', 'font-size': '12px', 'white-space': 'pre-wrap', 'max-height': '200px', overflow: 'auto', padding: '8px', background: '#0d1117', 'border-radius': '4px', 'margin-top': '4px' }}>
          {block.thinking}
        </div>
      </details>
    )
  }
  if (block.type === 'tool_use') {
    const name = block.name || 'tool'
    const color = TOOL_COLORS[name] || '#73b8ff'
    const icon = TOOL_ICONS[name] || '⚙'
    const summary = toolSummary(name, block.input)
    const inp = block.input || {}
    const hasDetail = name === 'Edit' || name === 'Bash' || name === 'Write'
    const pre = 'white-space:pre;font-size:11px;font-family:SF Mono,Menlo,monospace;padding:6px 10px;max-height:200px;overflow:auto;margin:0;word-break:normal;overflow-wrap:normal;-webkit-overflow-scrolling:touch;'
    return (
      <details style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-left': `3px solid ${color}`, 'border-radius': '6px', margin: '4px 0', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace" }}>
        <summary style={{ padding: '6px 10px', cursor: hasDetail ? 'pointer' : 'default', 'list-style': hasDetail ? undefined : 'none' }}>
          <span style={{ color }}>{icon} {name}</span>
          {summary && <span style={{ color: '#aeb6c2', 'margin-left': '8px' }}>{summary}</span>}
        </summary>
        {name === 'Edit' && <>
          {inp.old_string && <pre style={`${pre}color:#d45555;background:#1a0000;border-top:1px solid #1e1e1e`}>{inp.old_string}</pre>}
          {inp.new_string && <pre style={`${pre}color:#4aba6a;background:#001a00;border-top:1px solid #1e1e1e`}>{inp.new_string}</pre>}
        </>}
        {name === 'Bash' && inp.command && <pre style={`${pre}color:#e5946b;border-top:1px solid #1e1e1e`}>{inp.command}</pre>}
        {name === 'Write' && inp.content && <pre style={`${pre}color:#4aba6a;background:#001a00;border-top:1px solid #1e1e1e`}>{(inp.content as string).slice(0, 500)}{(inp.content as string).length > 500 ? '…' : ''}</pre>}
      </details>
    )
  }
  if (block.type === 'tool_result') {
    const rawContent = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((c: any) => c.text || '').join('') : ''
    const raw = stripAnsi(rawContent)
    const preview = raw.slice(0, 200)
    const isErr = block.is_error
    return (
      <div
        role="group"
        aria-label={isErr ? 'Tool error output' : 'Tool output'}
        style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-left': `3px solid ${isErr ? '#d45555' : '#4aba6a'}`, 'border-radius': '6px', margin: '4px 0', overflow: 'hidden' }}
      >
        <div style={{ padding: '2px 10px', background: '#111318', 'border-bottom': '1px solid #1e1e1e', 'font-size': '9px', 'font-weight': '600', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', color: isErr ? '#ff9b9b' : '#7c8595' }}>{isErr ? 'error' : 'output'}</div>
        {preview && <div tabindex="0" style={{ padding: '6px 10px', 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", color: isErr ? '#ff9b9b' : '#aeb6c2', 'white-space': 'pre', 'overflow-x': 'auto', 'overflow-y': 'visible', 'word-break': 'normal' }}>{preview}{raw.length > 200 ? '…' : ''}</div>}
      </div>
    )
  }
  return null
}

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
}

function messageA11yLabel(msg: Message) {
  const sender = msg.role === 'user' ? 'You' : 'Assistant'
  const timestamp = formatTime(msg.timestamp)
  return timestamp ? `${sender} at ${timestamp}` : sender
}

// ── Markdown styles ─────────────────────────────────────────────────────────

const markdownCSS = `
.markdown { line-height: 1.55; word-break: break-word; }
.markdown p { margin: 0 0 8px 0; }
.markdown p:last-child { margin-bottom: 0; }
.markdown h1, .markdown h2, .markdown h3, .markdown h4 { margin: 12px 0 6px 0; font-weight: 600; }
.markdown h1 { font-size: 1.3em; }
.markdown h2 { font-size: 1.15em; }
.markdown h3 { font-size: 1.05em; }
.markdown ul, .markdown ol { margin: 4px 0; padding-left: 20px; }
.markdown li { margin: 2px 0; }
.markdown code {
  background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 3px;
  font-family: 'SF Mono', Menlo, 'Courier New', monospace; font-size: 0.88em;
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
}
.markdown pre { margin: 8px 0; border-radius: 6px; overflow-x: auto; background: #0d1117; padding: 10px 12px; }
.markdown pre code { background: none; padding: 0; font-size: 0.85em; color: #c9d1d9; }
.markdown blockquote {
  margin: 6px 0; padding: 4px 12px; border-left: 3px solid #7c8595; color: #c9d1d9;
}
.markdown table {
  display: block; overflow-x: auto; max-width: 100%; width: max-content; min-width: 100%;
  border-collapse: collapse; margin: 8px 0; font-size: 0.9em; -webkit-overflow-scrolling: touch;
}
.markdown th, .markdown td { border: 1px solid #333; padding: 5px 10px; text-align: left; white-space: nowrap; }
.markdown th { background: rgba(255,255,255,0.05); font-weight: 600; }
.markdown a { color: #73b8ff; text-decoration: none; }
.markdown a:hover { text-decoration: underline; }
.markdown img { max-width: 100%; border-radius: 6px; }
.markdown hr { border: none; border-top: 1px solid #333; margin: 12px 0; }
.markdown strong { font-weight: 600; }
`

// ── Image extraction ─────────────────────────────────────────────────────────

const imgPattern = /\[Attached image: (\/uploads\/[^\]]+)\]/g

function extractImages(text: string): { cleanText: string; images: string[] } {
  const images: string[] = []
  const cleanText = stripInternalTags(text).replace(imgPattern, (_, p) => { images.push(p); return '' }).trim()
  return { cleanText, images }
}

// ── Component ───────────────────────────────────────────────────────────────

export function MessageView(props: { messages: Message[], loading: boolean }) {
  const [lightbox, setLightbox] = createSignal<string | null>(null)
  let scrollRef: HTMLDivElement | undefined
  let lightboxCloseRef: HTMLButtonElement | undefined
  const [pinned, setPinned] = createSignal(true) // pinned to bottom by default

  function onScroll() {
    if (!scrollRef) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef
    setPinned(scrollHeight - scrollTop - clientHeight < 80)
  }

  createEffect(on(
    () => props.messages.map(msg => `${msg.uuid}:${msg.delivery ?? ''}`).join('|'),
    () => {
      const lastMessage = props.messages.at(-1)
      if (!lastMessage) return
      if (!pinned() && !lastMessage.uuid.startsWith('optimistic-')) return
      requestAnimationFrame(() => scrollRef?.scrollTo({ top: scrollRef!.scrollHeight }))
    },
  ))

  createEffect(() => {
    if (!lightbox()) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    requestAnimationFrame(() => lightboxCloseRef?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLightbox(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKeyDown)
    })
  })

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Chat transcript"
      style={{ height: '100%', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', padding: '16px', 'padding-bottom': '80px' }}
    >
      <style>{markdownCSS}</style>
      <Show when={props.loading}>
        <div role="status" aria-live="polite" aria-atomic="true" style={{ color: '#7c8595', 'text-align': 'center', padding: '40px' }}>Loading...</div>
      </Show>
      {/* Lightbox */}
      <Show when={lightbox()}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Expanded attachment preview"
          aria-describedby="lightbox-help"
          onClick={() => setLightbox(null)}
          style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.85)', 'z-index': '200', display: 'flex', 'align-items': 'center', 'justify-content': 'center', cursor: 'zoom-out' }}
        >
          <p
            id="lightbox-help"
            style={{
              position: 'absolute',
              width: '1px',
              height: '1px',
              padding: '0',
              margin: '-1px',
              overflow: 'hidden',
              clip: 'rect(0, 0, 0, 0)',
              'white-space': 'nowrap',
              border: '0',
            }}
          >
            Press Escape or activate the close button to dismiss the image preview.
          </p>
          <button
            type="button"
            ref={lightboxCloseRef}
            aria-label="Close image preview"
            onClick={(event) => {
              event.stopPropagation()
              setLightbox(null)
            }}
            style={{
              position: 'absolute',
              top: '16px',
              right: '16px',
              width: '44px',
              height: '44px',
              border: '1px solid #333',
              'border-radius': '999px',
              background: 'rgba(13,17,23,0.92)',
              color: '#c9d1d9',
              'font-size': '24px',
              'line-height': '1',
              cursor: 'pointer',
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
            }}
          >
            ×
          </button>
          <img
            alt="Expanded attachment preview"
            src={lightbox()!}
            onClick={(event) => event.stopPropagation()}
            style={{ 'max-width': '95vw', 'max-height': '95vh', 'object-fit': 'contain', 'border-radius': '8px' }}
          />
        </div>
      </Show>

      <For each={props.messages}>{(msg) => {
        // Extract images from text blocks
        const textBlock = msg.content?.find(b => b.type === 'text' && b.text)
        const { cleanText, images } = textBlock?.text ? extractImages(textBlock.text) : { cleanText: textBlock?.text || '', images: [] }
        const hasImages = images.length > 0

        return <article
          aria-label={messageA11yLabel(msg)}
          style={{ display: 'flex', 'flex-direction': 'column', 'align-items': msg.role === 'user' ? 'flex-end' : 'flex-start', 'margin-bottom': '16px' }}
        >
          <div style={{
            'max-width': '85%', padding: hasImages ? '6px' : '10px 14px',
            'border-radius': msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
            background: msg.role === 'user' ? 'rgba(74,186,106,0.15)' : '#1a1a2e',
            color: '#e5e5e5', overflow: 'hidden',
            'font-size': '14px', 'line-height': '1.5', 'word-break': 'break-word',
          }}>
            {/* Inline images */}
            <For each={images}>{(src) => (
              <button
                type="button"
                onClick={() => setLightbox(src)}
                aria-label="Expand attached image"
                style={{ padding: '0', border: 'none', background: 'none', cursor: 'zoom-in', display: 'block', width: '100%', 'text-align': 'left' }}
              >
                <img alt="Attached image" src={src} style={{ 'max-width': '100%', 'max-height': '300px', 'border-radius': hasImages ? '12px' : '6px', 'margin-bottom': '4px', display: 'block' }} />
              </button>
            )}</For>
            {/* Text + other blocks */}
            <div style={hasImages ? { padding: '4px 8px 4px' } : {}}>
              <For each={msg.content}>{(block) => {
                if (block.type === 'text' && block.text) {
                  const display = hasImages ? cleanText : block.text
                  return display ? <div class="markdown" innerHTML={renderMarkdown(display)} /> : null
                }
                return renderBlock(block)
              }}</For>
            </div>
          </div>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '4px', 'margin-top': '4px', padding: '0 4px', 'justify-content': msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <span style={{ 'font-size': '10px', color: '#7c8595' }}>{formatTime(msg.timestamp)}</span>
            {msg.role === 'user' && msg.delivery && (
              <span
                role="img"
                aria-label={msg.delivery === 'delivered' ? 'Delivered' : 'Pending delivery'}
                title={msg.delivery === 'delivered' ? 'Delivered' : 'Pending delivery'}
                style={{ 'font-size': '11px', color: msg.delivery === 'delivered' ? '#4aba6a' : '#7c8595' }}
              >
                {msg.delivery === 'delivered' ? '\u2713\u2713' : '\u2713'}
              </span>
            )}
          </div>
        </article>
      }}</For>
    </div>
  )
}
