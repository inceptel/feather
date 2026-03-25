import { For, Show, createEffect, createSignal } from 'solid-js'
import type { Message, ContentBlock } from '../api'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'

// ── Markdown renderer with LRU cache ────────────────────────────────────────

const marked = new Marked({ gfm: true, breaks: true })
const mdCache = new Map<string, string>()
const MD_CACHE_MAX = 2000

function renderMarkdown(text: string): string {
  const cached = mdCache.get(text)
  if (cached !== undefined) return cached
  const html = marked.parse(text.trimEnd()) as string
  const safe = DOMPurify.sanitize(html)
  if (mdCache.size >= MD_CACHE_MAX) {
    const first = mdCache.keys().next().value!
    mdCache.delete(first)
  }
  mdCache.set(text, safe)
  return safe
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
        <div style={{ color: '#999', 'font-size': '12px', 'white-space': 'pre-wrap', 'max-height': '200px', overflow: 'auto', padding: '8px', background: '#0d1117', 'border-radius': '4px', 'margin-top': '4px' }}>
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
    const pre = 'white-space:pre-wrap;font-size:11px;font-family:SF Mono,Menlo,monospace;padding:6px 10px;max-height:200px;overflow:auto;margin:0;word-break:break-all;'
    return (
      <details style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-left': `3px solid ${color}`, 'border-radius': '6px', margin: '4px 0', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace" }}>
        <summary style={{ padding: '6px 10px', cursor: hasDetail ? 'pointer' : 'default', 'list-style': hasDetail ? undefined : 'none' }}>
          <span style={{ color }}>{icon} {name}</span>
          {summary && <span style={{ color: '#888', 'margin-left': '8px' }}>{summary}</span>}
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
    const raw = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((c: any) => c.text || '').join('') : ''
    const preview = raw.slice(0, 200)
    const isErr = block.is_error
    return (
      <div style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-left': `3px solid ${isErr ? '#d45555' : '#4aba6a'}`, 'border-radius': '6px', margin: '4px 0', overflow: 'hidden' }}>
        <div style={{ padding: '2px 10px', background: '#111318', 'border-bottom': '1px solid #1e1e1e', 'font-size': '9px', 'font-weight': '600', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', color: isErr ? '#d45555' : '#666' }}>{isErr ? 'error' : 'output'}</div>
        {preview && <div style={{ padding: '6px 10px', 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", color: isErr ? '#d45555' : '#888', 'white-space': 'pre-wrap', 'max-height': '120px', overflow: 'auto', 'word-break': 'break-all' }}>{preview}{raw.length > 200 ? '…' : ''}</div>}
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
  margin: 6px 0; padding: 4px 12px; border-left: 3px solid #444; color: #999;
}
.markdown table { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: 0.9em; }
.markdown th, .markdown td { border: 1px solid #333; padding: 5px 10px; text-align: left; }
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
  const cleanText = text.replace(imgPattern, (_, p) => { images.push(p); return '' }).trim()
  return { cleanText, images }
}

// ── Component ───────────────────────────────────────────────────────────────

export function MessageView(props: { messages: Message[], loading: boolean }) {
  const [lightbox, setLightbox] = createSignal<string | null>(null)
  let scrollRef: HTMLDivElement | undefined
  const [pinned, setPinned] = createSignal(true) // pinned to bottom by default

  function onScroll() {
    if (!scrollRef) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef
    setPinned(scrollHeight - scrollTop - clientHeight < 80)
  }

  createEffect(() => {
    props.messages.length // track
    if (pinned()) {
      requestAnimationFrame(() => scrollRef?.scrollTo({ top: scrollRef!.scrollHeight }))
    }
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
        <div style={{ color: '#555', 'text-align': 'center', padding: '40px' }}>Loading...</div>
      </Show>
      {/* Lightbox */}
      <Show when={lightbox()}>
        <div onClick={() => setLightbox(null)} style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.85)', 'z-index': '200', display: 'flex', 'align-items': 'center', 'justify-content': 'center', cursor: 'zoom-out' }}>
          <img src={lightbox()!} style={{ 'max-width': '95vw', 'max-height': '95vh', 'object-fit': 'contain', 'border-radius': '8px' }} />
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
              <img src={src} onClick={() => setLightbox(src)} style={{ 'max-width': '100%', 'max-height': '300px', 'border-radius': hasImages ? '12px' : '6px', 'margin-bottom': '4px', cursor: 'zoom-in', display: 'block' }} />
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
              <span style={{ 'font-size': '11px', color: msg.delivery === 'delivered' ? '#4aba6a' : '#555' }}>
                {msg.delivery === 'delivered' ? '\u2713\u2713' : '\u2713'}
              </span>
            )}
          </div>
        </article>
      }}</For>
    </div>
  )
}
