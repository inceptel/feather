import { For, Show, createEffect, createSignal } from 'solid-js'
import type { Message, ContentBlock } from '../api'
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import diff from 'highlight.js/lib/languages/diff'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)

// ── Markdown renderer with LRU cache ────────────────────────────────────────

const marked = new Marked(
  { gfm: true, breaks: true },
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
      return code
    },
  }),
)
const mdCache = new Map<string, string>()
const MD_CACHE_MAX = 2000

function renderMarkdown(text: string): string {
  const cached = mdCache.get(text)
  if (cached !== undefined) return cached
  const html = marked.parse(text.trimEnd()) as string
  const safe = DOMPurify.sanitize(html, { ADD_ATTR: ['class', 'target', 'rel'] })
  if (mdCache.size >= MD_CACHE_MAX) {
    const first = mdCache.keys().next().value!
    mdCache.delete(first)
  }
  mdCache.set(text, safe)
  return safe
}

// Copy button handler — attached via event delegation
function handleCopyClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('.copy-btn') as HTMLElement | null
  if (!btn) return
  const pre = btn.closest('pre')
  const code = pre?.querySelector('code')
  if (!code) return
  navigator.clipboard.writeText(code.textContent || '').then(() => {
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
  })
}

// Auto-collapse long code blocks (>25 lines)
function collapseCodeBlocks(el: HTMLElement) {
  for (const pre of el.querySelectorAll('pre')) {
    if (pre.querySelector('.code-expand-btn') || pre.closest('.code-collapse-wrapper')) continue
    const code = pre.querySelector('code')
    if (!code) continue
    const lineCount = (code.textContent || '').split('\n').length
    if (lineCount < 25) continue
    const hiddenLines = lineCount - 15
    pre.classList.add('code-collapsed')
    const wrapper = document.createElement('div')
    wrapper.className = 'code-collapse-wrapper'
    pre.parentNode!.insertBefore(wrapper, pre)
    wrapper.appendChild(pre)
    const btn = document.createElement('button')
    btn.className = 'code-expand-btn'
    btn.textContent = `Show ${hiddenLines} more lines`
    btn.onclick = (e) => {
      e.stopPropagation()
      const collapsed = pre.classList.toggle('code-collapsed')
      btn.textContent = collapsed ? `Show ${hiddenLines} more lines` : 'Collapse'
    }
    wrapper.appendChild(btn)
  }
}

// Make all links open in new tab
function fixLinks(el: HTMLElement) {
  for (const a of el.querySelectorAll('a')) {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener')
  }
}

// Inject copy buttons into rendered HTML pre blocks
function injectCopyButtons(el: HTMLElement) {
  for (const pre of el.querySelectorAll('pre')) {
    if (pre.querySelector('.copy-btn')) continue
    pre.style.position = 'relative'
    const btn = document.createElement('button')
    btn.className = 'copy-btn'
    btn.textContent = 'Copy'
    pre.appendChild(btn)
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
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
    return <div class="markdown" innerHTML={renderMarkdown(block.text)} ref={(el) => { injectCopyButtons(el); fixLinks(el); collapseCodeBlocks(el) }} />
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
    const hasDetail = name === 'Edit' || name === 'Bash' || name === 'Write' || name === 'Agent' || name === 'Grep' || name === 'Read'
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
        {name === 'Agent' && <>
          {inp.subagent_type && <div style={{ padding: '4px 10px', 'border-top': '1px solid #1e1e1e', 'font-size': '11px', color: '#888' }}>Type: <span style={{ color: '#c4993a' }}>{inp.subagent_type}</span></div>}
          {inp.prompt && <pre style={`${pre}color:#73b8ff;border-top:1px solid #1e1e1e`}>{(inp.prompt as string).slice(0, 800)}{(inp.prompt as string).length > 800 ? '…' : ''}</pre>}
        </>}
        {name === 'Grep' && inp.pattern && <pre style={`${pre}color:#b48ead;border-top:1px solid #1e1e1e`}>/{inp.pattern}/{inp.path ? ` in ${inp.path}` : ''}</pre>}
        {name === 'Read' && inp.file_path && <pre style={`${pre}color:#73b8ff;border-top:1px solid #1e1e1e`}>{inp.file_path}{inp.offset ? ` (L${inp.offset})` : ''}</pre>}
      </details>
    )
  }
  if (block.type === 'tool_result') {
    const rawContent = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((c: any) => c.text || '').join('') : ''
    const raw = stripAnsi(rawContent)
    const isErr = block.is_error
    const isLong = raw.length > 200
    const preview = raw.slice(0, 200)
    const lineCount = raw.split('\n').length
    const label = isErr ? 'error' : `output${isLong ? ` (${lineCount} lines)` : ''}`
    return (
      <details style={{ background: '#0d1117', border: '1px solid #1e1e1e', 'border-left': `3px solid ${isErr ? '#d45555' : '#4aba6a'}`, 'border-radius': '6px', margin: '4px 0', overflow: 'hidden' }} open={isErr || !isLong}>
        <summary style={{ padding: '2px 10px', background: '#111318', 'font-size': '9px', 'font-weight': '600', 'text-transform': 'uppercase', 'letter-spacing': '0.05em', color: isErr ? '#d45555' : '#666', cursor: isLong ? 'pointer' : 'default', 'list-style': isLong ? undefined : 'none' }}>
          {label}
          {isLong && !isErr && <span style={{ 'font-weight': '400', 'text-transform': 'none', 'margin-left': '8px', color: '#555' }}>{preview.split('\n')[0].slice(0, 60)}</span>}
        </summary>
        {raw && <div style={{ position: 'relative' }}>
          <div style={{ padding: '6px 10px', 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", color: isErr ? '#d45555' : '#888', 'white-space': 'pre-wrap', 'max-height': '300px', overflow: 'auto', 'word-break': 'break-all' }}>{raw.length > 3000 ? raw.slice(0, 3000) + '\n… (truncated)' : raw}</div>
          <button onClick={(e) => { navigator.clipboard.writeText(raw); const b = e.currentTarget; b.textContent = 'Copied!'; setTimeout(() => b.textContent = 'Copy', 1200) }}
            style={{ position: 'absolute', top: '4px', right: '4px', padding: '1px 6px', background: '#333', border: '1px solid #555', 'border-radius': '4px', color: '#999', 'font-size': '10px', cursor: 'pointer', opacity: '0.6' }}>Copy</button>
        </div>}
      </details>
    )
  }
  return null
}

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
}

function formatFullDate(iso: string) {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch { return '' }
}

// Copy message text to clipboard
function copyMessageText(el: HTMLElement) {
  navigator.clipboard.writeText(el.textContent || '').catch(() => {})
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
.markdown pre { margin: 8px 0; border-radius: 6px; overflow-x: auto; background: #0d1117; padding: 10px 12px; position: relative; }
.markdown pre code { background: none; padding: 0; font-size: 0.85em; color: #c9d1d9; }
.markdown pre.code-collapsed { max-height: 360px; overflow: hidden; }
.markdown pre.code-collapsed::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 60px; background: linear-gradient(transparent, #0d1117); pointer-events: none; border-radius: 0 0 6px 6px; }
.code-expand-btn { display: block; width: 100%; padding: 4px 0; margin-top: -1px; background: #0d1117; border: 1px solid #333; border-top: none; border-radius: 0 0 6px 6px; color: #fab283; font-size: 0.75em; font-family: -apple-system, system-ui, sans-serif; cursor: pointer; text-align: center; transition: background-color 0.2s, color 0.2s; }
.code-expand-btn:hover { background: #161b22; color: #fcd9b8; }
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

/* Copy button */
.copy-btn {
  position: absolute; top: 6px; right: 6px;
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
  color: #999; font-size: 11px; padding: 2px 8px; border-radius: 4px;
  cursor: pointer; opacity: 0; transition: opacity 0.15s;
  font-family: -apple-system, system-ui, sans-serif;
}
pre:hover .copy-btn { opacity: 1; }
.copy-btn:hover { background: rgba(255,255,255,0.2); color: #ccc; }

/* Typing indicator bounce */
@keyframes typing-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* Star button - show on hover */
.star-btn { -webkit-tap-highlight-color: transparent; }
div:hover > div > .star-btn { opacity: 0.6 !important; }
.star-btn:hover { opacity: 1 !important; }

/* highlight.js dark theme */
.hljs { color: #c9d1d9; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: #ff7b72; }
.hljs-function .hljs-keyword { color: #ff7b72; }
.hljs-string, .hljs-attr { color: #a5d6ff; }
.hljs-number, .hljs-meta { color: #79c0ff; }
.hljs-comment, .hljs-quote { color: #8b949e; font-style: italic; }
.hljs-title, .hljs-title.function_ { color: #d2a8ff; }
.hljs-built_in { color: #ffa657; }
.hljs-type, .hljs-class .hljs-title { color: #ffa657; }
.hljs-variable, .hljs-template-variable { color: #ffa657; }
.hljs-name { color: #7ee787; }
.hljs-selector-class { color: #7ee787; }
.hljs-addition { color: #aff5b4; background: rgba(46,160,67,0.15); }
.hljs-deletion { color: #ffdcd7; background: rgba(248,81,73,0.15); }
.hljs-regexp, .hljs-symbol { color: #f0883e; }
.hljs-params { color: #c9d1d9; }
.hljs-property { color: #79c0ff; }
`

// ── Image extraction ─────────────────────────────────────────────────────────

const imgPattern = /\[Attached image: (\/[^\]]+)\]/g

const filePattern = /\[Attached file: (\/[^\]]+)\]\s*\(([^)]+)\)/g

function extractImages(text: string): { cleanText: string; images: string[]; files: { path: string; name: string }[] } {
  const images: string[] = []
  const files: { path: string; name: string }[] = []
  let cleaned = text.replace(imgPattern, (_, p) => { images.push(p); return '' })
  cleaned = cleaned.replace(filePattern, (_, p, name) => { files.push({ path: p, name }); return '' }).trim()
  return { cleanText: cleaned, images, files }
}

// ── Component ───────────────────────────────────────────────────────────────

export function MessageView(props: { messages: Message[], loading: boolean, hasMore?: boolean, loadingMore?: boolean, onLoadEarlier?: () => void, onAnswer?: (text: string) => void, starred?: Set<string>, onToggleStar?: (uuid: string) => void, working?: boolean, scrollRefCb?: (el: HTMLDivElement) => void }) {
  const [lightbox, setLightbox] = createSignal<string | null>(null)
  let scrollRef: HTMLDivElement | undefined
  const [pinned, setPinned] = createSignal(true) // pinned to bottom by default
  const [newMsgCount, setNewMsgCount] = createSignal(0)
  let prevMsgLen = props.messages.length

  function onScroll() {
    if (!scrollRef) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef
    const near = scrollHeight - scrollTop - clientHeight < 80
    setPinned(near)
    if (near) setNewMsgCount(0)
  }

  function scrollToBottom() {
    scrollRef?.scrollTo({ top: scrollRef!.scrollHeight, behavior: 'smooth' })
    setNewMsgCount(0)
  }

  createEffect(() => {
    const len = props.messages.length
    const delta = len - prevMsgLen
    prevMsgLen = len
    if (pinned()) {
      requestAnimationFrame(() => scrollRef?.scrollTo({ top: scrollRef!.scrollHeight }))
    } else if (delta > 0) {
      setNewMsgCount(c => c + delta)
    }
  })

  return (
    <div style={{ position: 'relative', height: '100%' }}>
    <div ref={(el) => { scrollRef = el; props.scrollRefCb?.(el) }} onScroll={onScroll} onClick={handleCopyClick} style={{ height: '100%', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', padding: '16px', 'padding-bottom': '80px' }}>
      <style>{markdownCSS}</style>
      <Show when={props.loading}>
        <div style={{ color: '#555', 'text-align': 'center', padding: '40px' }}>Loading...</div>
      </Show>
      <Show when={props.hasMore && !props.loading}>
        <div style={{ 'text-align': 'center', padding: '12px' }}>
          <button onClick={() => props.onLoadEarlier?.()} disabled={props.loadingMore}
            style={{ background: '#1a1a2e', border: '1px solid #333', color: '#73b8ff', padding: '6px 16px', 'border-radius': '6px', 'font-size': '12px', cursor: props.loadingMore ? 'wait' : 'pointer' }}>
            {props.loadingMore ? 'Loading...' : 'Load earlier messages'}
          </button>
        </div>
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
        const { cleanText, images, files } = textBlock?.text ? extractImages(textBlock.text) : { cleanText: textBlock?.text || '', images: [], files: [] }
        const hasImages = images.length > 0
        const hasFiles = files.length > 0
        const hasAttachments = hasImages || hasFiles

        return <div style={{ display: 'flex', 'flex-direction': 'column', 'align-items': msg.role === 'user' ? 'flex-end' : 'flex-start', 'margin-bottom': '10px' }}>
          <div style={{
            'max-width': '85%', padding: hasAttachments ? '6px' : '10px 14px',
            'border-radius': msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
            background: msg.role === 'user' ? 'rgba(74,186,106,0.15)' : '#1a1a2e',
            color: '#e5e5e5', overflow: 'hidden',
            'font-size': '14px', 'line-height': '1.5', 'word-break': 'break-word',
          }}>
            {/* Inline images */}
            <For each={images}>{(src) => (
              <img src={src} onClick={() => setLightbox(src)} style={{ 'max-width': '100%', 'max-height': '300px', 'border-radius': hasAttachments ? '12px' : '6px', 'margin-bottom': '4px', cursor: 'zoom-in', display: 'block' }} />
            )}</For>
            {/* File attachments */}
            <For each={files}>{(f) => (
              <a href={f.path} target="_blank" rel="noopener" style={{ display: 'flex', 'align-items': 'center', gap: '6px', padding: '6px 10px', margin: '2px 0', background: 'rgba(255,255,255,0.05)', 'border-radius': '8px', 'text-decoration': 'none', color: '#73b8ff', 'font-size': '12px' }}>
                <span style={{ 'font-size': '16px' }}>{f.name.endsWith('.pdf') ? '\uD83D\uDCC4' : '\uD83D\uDCCE'}</span>
                <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{f.name}</span>
              </a>
            )}</For>
            {/* Text + other blocks */}
            <div style={hasAttachments ? { padding: '4px 8px 4px' } : {}}>
              <For each={msg.content}>{(block) => {
                if (block.type === 'text' && block.text) {
                  const display = hasAttachments ? cleanText : block.text
                  return display ? <div class="markdown" innerHTML={renderMarkdown(display)} ref={(el) => { injectCopyButtons(el); fixLinks(el); collapseCodeBlocks(el) }} /> : null
                }
                if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                  const q = block.input?.question || 'Claude is asking a question...'
                  return (
                    <div style={{ background: '#1a1a2e', border: '1px solid #c4993a', 'border-radius': '8px', padding: '12px', margin: '6px 0' }}>
                      <div style={{ color: '#c4993a', 'font-size': '11px', 'font-weight': '600', 'margin-bottom': '6px' }}>QUESTION</div>
                      <div style={{ color: '#e5e5e5', 'font-size': '14px', 'margin-bottom': '10px' }}>{q}</div>
                      <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
                        <For each={['Yes', 'No', 'Continue']}>{(label) => (
                          <button onClick={() => props.onAnswer?.(label)}
                            style={{ background: '#333', border: '1px solid #555', color: '#e5e5e5', padding: '4px 12px', 'border-radius': '6px', 'font-size': '12px', cursor: 'pointer' }}>{label}</button>
                        )}</For>
                      </div>
                    </div>
                  )
                }
                return renderBlock(block)
              }}</For>
            </div>
          </div>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '4px', 'margin-top': '4px', padding: '0 4px', 'justify-content': msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <span onClick={(e) => { const el = e.currentTarget; el.textContent = el.textContent === formatTime(msg.timestamp) ? formatFullDate(msg.timestamp) : formatTime(msg.timestamp) }}
              style={{ 'font-size': '10px', color: '#444', cursor: 'pointer', '-webkit-tap-highlight-color': 'transparent' }}>{formatTime(msg.timestamp)}</span>
            {msg.role === 'user' && msg.delivery && (
              <span style={{ 'font-size': '11px', color: msg.delivery === 'delivered' ? '#4aba6a' : '#555' }}>
                {msg.delivery === 'delivered' ? '\u2713\u2713' : '\u2713'}
              </span>
            )}
            {!msg.uuid.startsWith('optimistic-') && (
              <button onClick={() => props.onToggleStar?.(msg.uuid)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', 'font-size': '12px', padding: '0 2px', color: props.starred?.has(msg.uuid) ? '#c4993a' : '#333', opacity: props.starred?.has(msg.uuid) ? '1' : '0', transition: 'opacity 0.15s' }}
                class="star-btn">{props.starred?.has(msg.uuid) ? '\u2605' : '\u2606'}</button>
            )}
          </div>
        </div>
      }}</For>

      {/* Typing indicator */}
      <Show when={props.working}>
        <div style={{ display: 'flex', 'align-items': 'flex-start', 'margin-bottom': '10px' }}>
          <div style={{ padding: '10px 16px', 'border-radius': '16px 16px 16px 4px', background: '#1a1a2e', display: 'flex', gap: '4px', 'align-items': 'center' }}>
            <span class="typing-dot" style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#888', 'animation': 'typing-bounce 1.2s ease-in-out infinite' }} />
            <span class="typing-dot" style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#888', 'animation': 'typing-bounce 1.2s ease-in-out 0.2s infinite' }} />
            <span class="typing-dot" style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#888', 'animation': 'typing-bounce 1.2s ease-in-out 0.4s infinite' }} />
          </div>
        </div>
      </Show>
    </div>
    {/* Scroll to bottom button */}
    <Show when={!pinned() && newMsgCount() > 0}>
      <button onClick={scrollToBottom}
        style={{ position: 'absolute', bottom: '16px', left: '50%', transform: 'translateX(-50%)', background: '#4aba6a', color: '#000', border: 'none', 'border-radius': '20px', padding: '6px 16px', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer', 'box-shadow': '0 2px 8px rgba(0,0,0,0.4)', 'z-index': '10', '-webkit-tap-highlight-color': 'transparent' }}>
        {newMsgCount()} new {'\u2193'}
      </button>
    </Show>
    </div>
  )
}
