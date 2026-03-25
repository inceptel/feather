import { For, Show, createEffect, createMemo } from 'solid-js'
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
    return <div style={{ color: '#73b8ff', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace" }}>{block.name || 'tool_use'}</div>
  }
  if (block.type === 'tool_result') {
    const preview = typeof block.content === 'string' ? block.content.slice(0, 80) : ''
    return (
      <div style={{ color: block.is_error ? '#d45555' : '#555', 'font-size': '12px', 'font-family': "'SF Mono', Menlo, monospace" }}>
        {block.is_error ? 'Error' : 'Result'}{preview ? `: ${preview}` : ''}
      </div>
    )
  }
  return null
}

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
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

// ── Component ───────────────────────────────────────────────────────────────

export function MessageView(props: { messages: Message[], loading: boolean }) {
  let scrollRef: HTMLDivElement | undefined

  createEffect(() => {
    props.messages.length // track
    setTimeout(() => scrollRef?.scrollTo({ top: scrollRef.scrollHeight, behavior: 'smooth' }), 50)
  })

  return (
    <div ref={scrollRef} style={{ height: '100%', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', padding: '16px', 'padding-bottom': '80px' }}>
      <style>{markdownCSS}</style>
      <Show when={props.loading}>
        <div style={{ color: '#555', 'text-align': 'center', padding: '40px' }}>Loading...</div>
      </Show>
      <For each={props.messages}>{(msg) => (
        <div style={{ display: 'flex', 'flex-direction': 'column', 'align-items': msg.role === 'user' ? 'flex-end' : 'flex-start', 'margin-bottom': '16px' }}>
          <div style={{
            'max-width': '85%', padding: '10px 14px',
            'border-radius': msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
            background: msg.role === 'user' ? 'rgba(74,186,106,0.15)' : '#1a1a2e',
            color: '#e5e5e5',
            'font-size': '14px', 'line-height': '1.5', 'word-break': 'break-word',
          }}>
            <For each={msg.content}>{(block) => renderBlock(block)}</For>
          </div>
          <span style={{ 'font-size': '10px', color: '#444', 'margin-top': '4px', padding: '0 4px' }}>{formatTime(msg.timestamp)}</span>
        </div>
      )}</For>
    </div>
  )
}
