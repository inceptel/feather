import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type { Message, ContentBlock } from '../api'
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import DOMPurify from 'dompurify'
import Anser from 'anser'
import { createTwoFilesPatch } from 'diff'
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
import {
  commandText,
  patchText,
  stdinText,
  toolImagePath,
  toolInputText,
  toolPresentation,
} from '../lib/toolPresentation.js'
import { localFilePath, localFileUrl } from '../lib/localMedia.js'
import { extractImages } from '../lib/attachments.js'

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

function wirePathLink(a: HTMLAnchorElement, targetPath: string) {
  a.classList.add('feather-path')
  a.href = '#'
  a.removeAttribute('target')
  a.removeAttribute('rel')
  a.dataset.path = targetPath
  a.addEventListener('click', (ev) => {
    ev.preventDefault()
    window.dispatchEvent(new CustomEvent('feather:open-path', { detail: { path: targetPath } }))
  })
}

function filesystemPathFromHref(a: HTMLAnchorElement): string | null {
  return localFilePath(a.getAttribute('href'))
}

// Make web links open in a new tab and route Markdown filesystem links through
// Feather's file viewer, just like bare paths linkified below.
function fixLinks(el: HTMLElement) {
  for (const a of el.querySelectorAll('a')) {
    const targetPath = filesystemPathFromHref(a)
    if (targetPath) {
      wirePathLink(a, targetPath)
      continue
    }
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener')
  }
}

// Route Markdown images whose src is a local filesystem path (absolute, ~/,
// or file://) through the authenticated /api/file endpoint. The browser would
// otherwise request the raw path as a site URL and show a broken image.
// If the file fails to load (missing, or not an image), fall back to a
// clickable path link that opens Feather's file viewer.
function replaceImageWithPathLink(img: HTMLImageElement, targetPath: string) {
  const a = document.createElement('a')
  a.textContent = targetPath
  wirePathLink(a, targetPath)
  img.replaceWith(a)
}

function fixImages(el: HTMLElement, setLightbox?: (v: string | null) => void) {
  for (const img of el.querySelectorAll('img')) {
    const targetPath = localFilePath(img.getAttribute('src'))
    if (!targetPath) continue
    const url = localFileUrl(targetPath)!
    img.src = url
    img.loading = 'lazy'
    img.classList.add('md-local-img')
    if (!img.alt) img.alt = targetPath.split('/').pop() || 'image'
    const insideLink = !!img.closest('a')
    if (!insideLink) {
      img.style.cursor = 'zoom-in'
      img.addEventListener('click', () => {
        if (setLightbox) setLightbox(url)
        else window.dispatchEvent(new CustomEvent('feather:open-path', { detail: { path: targetPath } }))
      })
    }
    img.addEventListener('error', () => replaceImageWithPathLink(img, targetPath), { once: true })
  }
}

// Wrap absolute filesystem paths in clickable links that dispatch to App.
// Skips paths inside <a> (already linked) and <pre> (code blocks). Inline
// <code> is fine — paths in backticks should still be clickable.
// Matches absolute (/a/b), home-relative (~/a/b), and file:// URLs.
const PATH_RE = /(?<![\w/:~])(?:file:\/\/)?(?:~|\/[\w.\-]+)(?:\/[\w.\-]+)+(?::\d+)?/g
const TRAILING_PUNCT_RE = /[.,;:!?)\]}]+$/

// Defer to next microtask so innerHTML / text children are populated first
// (Solid's ref fires before innerHTML is set or text children mounted).
const linkifyRef = (el: HTMLElement) => queueMicrotask(() => linkifyPaths(el))

function linkifyPaths(el: HTMLElement) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p: HTMLElement | null = (node as Text).parentElement
      while (p && p !== el) {
        const t = p.tagName
        if (t === 'A' || t === 'PRE') return NodeFilter.FILTER_REJECT
        p = p.parentElement
      }
      return (node.nodeValue && node.nodeValue.indexOf('/') !== -1)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT
    }
  })
  const targets: Text[] = []
  let n: Node | null
  while ((n = walker.nextNode())) targets.push(n as Text)
  for (const t of targets) {
    const text = t.nodeValue || ''
    PATH_RE.lastIndex = 0
    if (!PATH_RE.test(text)) continue
    PATH_RE.lastIndex = 0
    const frag = document.createDocumentFragment()
    let last = 0
    let m: RegExpExecArray | null
    let any = false
    while ((m = PATH_RE.exec(text))) {
      let raw = m[0]
      const trim = raw.match(TRAILING_PUNCT_RE)
      if (trim) raw = raw.slice(0, raw.length - trim[0].length)
      if (raw.length < 4) continue
      const start = m.index
      const end = start + raw.length
      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)))
      const a = document.createElement('a')
      a.textContent = raw
      const targetPath = raw.startsWith('file://') ? raw.slice(7) : raw
      wirePathLink(a, targetPath)
      frag.appendChild(a)
      last = end
      any = true
    }
    if (!any) continue
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    t.parentNode?.replaceChild(frag, t)
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

function enhanceTables(el: HTMLElement, setExpandedTable: (html: string) => void) {
  for (const table of el.querySelectorAll<HTMLTableElement>('table:not([data-feather-table])')) {
    table.dataset.featherTable = 'true'
    const rows = Array.from(table.rows)
    const columnCount = Math.max(0, ...rows.map((row) => row.cells.length))
    for (let column = 0; column < columnCount; column++) {
      const cells = rows.map((row) => row.cells[column]).filter(Boolean)
      const values = cells.map((cell) => (cell.textContent || '').trim()).filter(Boolean)
      const compact = values.every((value) => value.length <= 18 && !/\s{2,}|\n/.test(value))
      cells.forEach((cell) => cell.classList.add(compact ? 'md-col-compact' : 'md-col-wide'))
    }
    const frame = document.createElement('div')
    frame.className = 'md-table-frame'
    table.parentNode?.insertBefore(frame, table)
    frame.appendChild(table)
    const expand = document.createElement('button')
    expand.type = 'button'
    expand.className = 'md-table-expand'
    expand.setAttribute('aria-label', 'Expand table')
    expand.title = 'Expand table'
    expand.textContent = '↗'
    expand.addEventListener('click', (event) => {
      event.stopPropagation()
      setExpandedTable(DOMPurify.sanitize(table.outerHTML))
    })
    frame.appendChild(expand)
  }
}

function enhanceMarkdown(el: HTMLElement, setLightbox: (value: string | null) => void, setExpandedTable: (html: string) => void) {
  injectCopyButtons(el)
  fixLinks(el)
  fixImages(el, setLightbox)
  linkifyPaths(el)
  enhanceTables(el, setExpandedTable)
}

// ── Utilities ───────────────────────────────────────────────────────────────

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

// Render ANSI escape sequences as inline-styled HTML. Anser escapes entities.
function ansiToSafeHtml(raw: string): string {
  const html = Anser.ansiToHtml(raw)
  return DOMPurify.sanitize(html, { ADD_ATTR: ['style'] })
}

type DiffKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx'
function buildUnifiedDiff(oldText: string, newText: string, filePath: string): Array<{ line: string; kind: DiffKind }> {
  const patch = createTwoFilesPatch(filePath, filePath, oldText, newText, 'before', 'after', { context: 3 })
  const lines = patch.split('\n')
  // Skip the first 4 header lines (Index, ===, ---, +++) — too noisy inline
  return lines.slice(4).map(l => {
    if (l.startsWith('@@')) return { line: l, kind: 'hunk' as const }
    if (l.startsWith('+')) return { line: l, kind: 'add' as const }
    if (l.startsWith('-')) return { line: l, kind: 'del' as const }
    return { line: l, kind: 'ctx' as const }
  })
}

function diffLineStyle(kind: DiffKind): Record<string, string> {
  switch (kind) {
    case 'hunk': return { color: 'var(--info)', background: 'rgba(59,130,246,0.10)' }
    case 'add':  return { color: 'var(--diff-add-text)', background: 'var(--diff-add-bg)' }
    case 'del':  return { color: 'var(--diff-del-text)', background: 'var(--diff-del-bg)' }
    case 'meta': return { color: 'var(--text-dim)', 'font-weight': '600' }
    default:     return { color: 'var(--text-secondary)' }
  }
}

// ── Tool rendering ──────────────────────────────────────────────────────────

const TOOL_ICONS: Record<string, string> = {
  Read: '📄', Write: '✏️', Edit: '✂️', Bash: '⚡', Grep: '🔍', Glob: '🗂️',
  WebFetch: '🌐', WebSearch: '🔎', Agent: '🤖', Skill: '⚡',
  Web: '🌐', Patch: '✂️', Input: '↵',
}

const TOOL_COLORS: Record<string, string> = {
  Bash: 'var(--tool-bash)', Read: 'var(--tool-read)', Write: 'var(--tool-write)', Edit: 'var(--tool-edit)',
  Grep: 'var(--tool-grep)', Glob: 'var(--tool-glob)', WebFetch: 'var(--tool-glob)', WebSearch: 'var(--tool-grep)',
  Agent: 'var(--tool-agent)', Skill: 'var(--tool-skill)',
  Web: 'var(--tool-glob)', Patch: 'var(--tool-edit)', Input: 'var(--tool-read)',
}

const SPECIAL_TOOL_DETAILS = new Set(['Edit', 'Bash', 'Patch', 'Input', 'Write', 'Agent', 'Grep', 'Read'])

// ── Block renderers ─────────────────────────────────────────────────────────

function renderToolResultInner(block: ContentBlock, setLightbox?: (v: string | null) => void) {
  const contentArr = Array.isArray(block.content) ? block.content : typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : []
  const images = contentArr.filter((c: any) => c.type === 'image' && c.source?.data)
  const rawContent = contentArr.filter((c: any) => c.type !== 'image').map((c: any) => c.text || '').join('')
  const isErr = block.is_error
  const hasImages = images.length > 0
  const label = isErr ? 'error' : hasImages ? `image${images.length > 1 ? 's' : ''}` : `output${rawContent.length > 200 ? ` (${rawContent.split('\n').length} lines)` : ''}`
  return (
    <div style={{ 'margin-top': '6px', 'border-top': '1px solid var(--border-subtle)', background: 'var(--bg-base)' }}>
      <div style={{ padding: '4px 12px', 'font-size': '9px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.08em', color: isErr ? 'var(--error)' : 'var(--text-muted)' }}>{label}</div>
      {images.map((img: any) => (
        <div style={{ padding: '6px 12px' }}>
          <img src={`data:${img.source.media_type || 'image/png'};base64,${img.source.data}`} style={{ 'max-width': '100%', 'max-height': '400px', 'border-radius': '6px', cursor: setLightbox ? 'zoom-in' : 'default' }} onClick={() => setLightbox?.(`data:${img.source.media_type || 'image/png'};base64,${img.source.data}`)} />
        </div>
      ))}
      {rawContent && <div style={{ padding: '6px 12px', 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", color: isErr ? 'var(--error)' : 'var(--text-secondary)', 'white-space': 'pre-wrap', 'max-height': '300px', overflow: 'auto', 'word-break': 'break-all' }} innerHTML={ansiToSafeHtml(rawContent.length > 3000 ? rawContent.slice(0, 3000) + '\n… (truncated)' : rawContent)} ref={linkifyRef} />}
    </div>
  )
}

function renderBlock(block: ContentBlock, setLightbox: (v: string | null) => void, getResult: ((toolUseId: string) => ContentBlock | undefined) | undefined, setExpandedTable: (html: string) => void) {
  if (block.type === 'text' && block.text) {
    return <div class="markdown" innerHTML={renderMarkdown(block.text)} ref={(el) => queueMicrotask(() => enhanceMarkdown(el, setLightbox, setExpandedTable))} />
  }
  if (block.type === 'thinking' && block.thinking) {
    return (
      <details style={{ margin: '4px 0', 'border-left': '2px solid rgba(168,85,247,0.35)', 'padding-left': '12px' }}>
        <summary style={{ display: 'flex', 'align-items': 'center', gap: '6px', color: 'var(--text-muted)', 'font-size': '12px', cursor: 'pointer', 'list-style': 'none', 'user-select': 'none', padding: '2px 0' }}>
          <span style={{ color: '#c084fc', 'font-size': '13px', 'line-height': '1', width: '12px', display: 'inline-flex', 'align-items': 'center' }}>◉</span>
          <span style={{ color: '#c084fc' }}>Reasoning</span>
          <span style={{ 'margin-left': 'auto', color: 'var(--text-ghost)', 'font-size': '10px' }}>▸</span>
        </summary>
        <div style={{ 'margin-top': '6px', 'margin-left': '4px', padding: '10px 14px', background: 'rgba(168,85,247,0.04)', border: '1px solid rgba(168,85,247,0.12)', 'border-radius': '10px', color: 'var(--text-secondary)', 'font-size': '12px', 'white-space': 'pre-wrap', 'max-height': '400px', 'overflow-y': 'auto', 'line-height': '1.55', 'box-shadow': '0 1px 3px rgba(0,0,0,0.15)' }}>
          {block.thinking}
        </div>
      </details>
    )
  }
  if (block.type === 'tool_use') {
    const inp = block.input || {}
    const { name, summary } = toolPresentation(block.name || '', inp)
    const color = TOOL_COLORS[name] || 'var(--info)'
    const icon = TOOL_ICONS[name] || '⚙'
    const result = block.id && getResult ? getResult(block.id) : undefined
    const imagePath = toolImagePath(block.name || '', inp)
    const imageUrl = imagePath ? localFileUrl(imagePath)! : ''
    const genericInput = SPECIAL_TOOL_DETAILS.has(name) ? '' : toolInputText(inp)
    const hasDetail = SPECIAL_TOOL_DETAILS.has(name) || !!genericInput || !!imagePath || !!result
    const pre = 'white-space:pre-wrap;font-size:11px;font-family:SF Mono,Menlo,monospace;padding:8px 12px;max-height:200px;overflow:auto;margin:0;word-break:break-all;'
    const isErr = result?.is_error
    const statusColor = isErr ? 'var(--error)' : result ? 'var(--success)' : 'var(--warning)'
    const statusIcon = isErr ? '✗' : result ? '✓' : '●'
    return (
      <details style={{ margin: '4px 0', 'border-left': '2px solid var(--border-medium)', 'padding-left': '12px' }}>
        <summary style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'font-size': '12px', color: 'var(--text-muted)', cursor: hasDetail ? 'pointer' : 'default', 'list-style': 'none', 'user-select': 'none', padding: '2px 0' }}>
          <span style={{ color: statusColor, 'font-size': '11px', 'line-height': '1', display: 'inline-flex', 'align-items': 'center', width: '12px', 'flex-shrink': '0' }}>{statusIcon}</span>
          <span style={{ color, 'font-family': "'SF Mono', Menlo, monospace", 'font-size': '11px', 'flex-shrink': '0' }}>{icon} {name}</span>
          {summary && <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1', 'min-width': '0', 'font-family': "'SF Mono', Menlo, monospace", 'font-size': '11px' }}>{summary}</span>}
          {hasDetail && <span style={{ 'margin-left': 'auto', color: 'var(--text-ghost)', 'font-size': '10px', 'flex-shrink': '0' }}>▸</span>}
        </summary>
        <div style={{ 'margin-top': '6px', 'margin-left': '4px', background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', 'border-radius': '10px', overflow: 'hidden', 'box-shadow': '0 1px 3px rgba(0,0,0,0.2)' }}>
        {name === 'Edit' && inp.old_string != null && inp.new_string != null && (
          <div style={{ 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", 'line-height': '1.5', 'max-height': '400px', overflow: 'auto' }}>
            <For each={buildUnifiedDiff(inp.old_string as string, inp.new_string as string, (inp.file_path as string) || 'file')}>
              {({ line, kind }) => (
                <div style={{ padding: '0 12px', 'white-space': 'pre', ...diffLineStyle(kind) }}>{line || ' '}</div>
              )}
            </For>
          </div>
        )}
        {name === 'Bash' && commandText(inp) && <pre style={`${pre}color:var(--tool-bash);`} ref={linkifyRef}>{commandText(inp)}</pre>}
        {name === 'Patch' && patchText(inp) && <pre style={`${pre}color:var(--tool-edit);`} ref={linkifyRef}>{patchText(inp).slice(0, 2000)}{patchText(inp).length > 2000 ? '\n…' : ''}</pre>}
        {name === 'Input' && <pre style={`${pre}color:var(--tool-read);`} ref={linkifyRef}>{stdinText(inp).replace(/\u0003/g, '^C') || '(empty stdin)'}{inp.session_id != null ? `\n\nsession: ${inp.session_id}` : ''}</pre>}
        {name === 'Write' && inp.content && <pre style={`${pre}color:var(--diff-add-text);background:var(--diff-add-bg);`} ref={linkifyRef}>{(inp.content as string).slice(0, 500)}{(inp.content as string).length > 500 ? '…' : ''}</pre>}
        {name === 'Agent' && <>
          {inp.subagent_type && <div style={{ padding: '6px 12px', 'font-size': '11px', color: 'var(--text-secondary)' }}>Type: <span style={{ color: 'var(--warning)' }}>{inp.subagent_type}</span></div>}
          {inp.prompt && <pre style={`${pre}color:var(--tool-agent);`} ref={linkifyRef}>{(inp.prompt as string).slice(0, 800)}{(inp.prompt as string).length > 800 ? '…' : ''}</pre>}
        </>}
        {name === 'Grep' && inp.pattern && <pre style={`${pre}color:var(--tool-grep);`}>/{inp.pattern}/{inp.path ? ` in ${inp.path}` : ''}</pre>}
        {name === 'Read' && (inp.file_path || inp.path) && <pre style={`${pre}color:var(--tool-read);`} ref={linkifyRef}>{(inp.file_path || inp.path) as string}{inp.offset ? ` (L${inp.offset})` : ''}</pre>}
        {imagePath && (
          <button
            type="button"
            aria-label={`Open ${imagePath.split('/').pop() || 'image'} full screen`}
            onClick={() => setLightbox?.(imageUrl)}
            style={{
              display: 'block', width: '100%', padding: '8px', background: 'var(--bg-base)',
              border: 'none', cursor: setLightbox ? 'zoom-in' : 'default', 'text-align': 'left',
            }}
          >
            <img
              src={imageUrl}
              alt={imagePath.split('/').pop() || 'Tool image'}
              style={{ display: 'block', 'max-width': '100%', 'max-height': '240px', 'border-radius': '6px', 'object-fit': 'contain' }}
            />
          </button>
        )}
        {genericInput && <pre style={`${pre}color:var(--text-secondary);`} ref={linkifyRef}>{genericInput}</pre>}
        {result && renderToolResultInner(result, setLightbox)}
        </div>
      </details>
    )
  }
  // Orphaned tool_result (no matching tool_use in loaded messages) — render standalone
  if (block.type === 'tool_result') {
    const contentArr = Array.isArray(block.content) ? block.content : typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : []
    const images = contentArr.filter((c: any) => c.type === 'image' && c.source?.data)
    const rawContent = contentArr.filter((c: any) => c.type !== 'image').map((c: any) => c.text || '').join('')
    const raw = stripAnsi(rawContent)
    const isErr = block.is_error
    const hasImages = images.length > 0
    const isLong = raw.length > 200
    const preview = raw.slice(0, 200)
    const lineCount = raw.split('\n').length
    const label = isErr ? 'error' : hasImages ? `image${images.length > 1 ? 's' : ''}` : `output${isLong ? ` (${lineCount} lines)` : ''}`
    return (
      <details style={{ margin: '4px 0', 'border-left': `2px solid ${isErr ? 'var(--error)' : 'var(--border-medium)'}`, 'padding-left': '12px' }} open={isErr || !isLong || hasImages}>
        <summary style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'font-size': '10px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.08em', color: isErr ? 'var(--error)' : 'var(--text-muted)', cursor: isLong || hasImages ? 'pointer' : 'default', 'list-style': 'none', 'user-select': 'none', padding: '2px 0' }}>
          <span>{label}</span>
          {isLong && !isErr && !hasImages && <span style={{ 'font-weight': '400', 'text-transform': 'none', color: 'var(--text-dim)', 'font-family': "'SF Mono', Menlo, monospace", 'font-size': '11px' }}>{preview.split('\n')[0].slice(0, 60)}</span>}
        </summary>
        <div style={{ 'margin-top': '6px', 'margin-left': '4px', background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', 'border-radius': '10px', overflow: 'hidden', 'box-shadow': '0 1px 3px rgba(0,0,0,0.2)' }}>
        {images.map((img: any) => (
          <div style={{ padding: '6px 12px' }}>
            <img src={`data:${img.source.media_type || 'image/png'};base64,${img.source.data}`} style={{ 'max-width': '100%', 'max-height': '400px', 'border-radius': '6px', cursor: setLightbox ? 'zoom-in' : 'default' }} onClick={() => setLightbox?.(`data:${img.source.media_type || 'image/png'};base64,${img.source.data}`)} />
          </div>
        ))}
        {rawContent && <div style={{ padding: '8px 12px', 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", color: isErr ? 'var(--error)' : 'var(--text-secondary)', 'white-space': 'pre-wrap', 'max-height': '300px', overflow: 'auto', 'word-break': 'break-all' }} innerHTML={ansiToSafeHtml(rawContent.length > 3000 ? rawContent.slice(0, 3000) + '\n… (truncated)' : rawContent)} ref={linkifyRef} />}
        </div>
      </details>
    )
  }
  return null
}

function formatTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
}

// ── Execution-trace grouping ────────────────────────────────────────────────
// Any assistant message containing reasoning or tool activity is implementation
// detail, even when it also contains a text preamble ("Let me check…"). Group
// consecutive trace messages into one collapsed Work log. Text-only assistant
// messages remain first-class conversation. Questions stay visible because they
// require the user's attention.
function isQuestionBlock(block: ContentBlock): boolean {
  if (block.type !== 'tool_use') return false
  return block.name === 'AskUserQuestion' || block.name?.toLowerCase() === 'ask'
}

function isTraceAssistantMsg(m: Message): boolean {
  if (m.role !== 'assistant' || !m.content || m.content.length === 0) return false
  if (m.content.some(isQuestionBlock)) return false
  const hasTool = m.content.some(block => block.type === 'tool_use' || block.type === 'tool_result')
  const hasThinking = m.content.some(block => block.type === 'thinking')
  const hasText = m.content.some(block => block.type === 'text' && block.text?.trim())
  // Thinking alongside a text-only final answer stays with that answer, folded
  // into its local Work log. Thinking-only and anything with tools is trace.
  return hasTool || (hasThinking && !hasText)
}

function canAttachTraceToMessage(m: Message): boolean {
  if (m.role !== 'assistant' || !m.content?.some(block => block.type === 'text' && block.text?.trim())) return false
  return !m.content.some(isQuestionBlock)
}

type RenderItem =
  | { kind: 'msg'; msg: Message }
  | { kind: 'chain'; messages: Message[] }
  | { kind: 'turn'; msg: Message; trace: Message[] }

function buildRenderItems(messages: Message[], isPureToolResult: (m: Message) => boolean): RenderItem[] {
  const out: RenderItem[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (isPureToolResult(m)) { i++; continue }
    if (isTraceAssistantMsg(m)) {
      const chain: Message[] = [m]
      let j = i + 1
      while (j < messages.length) {
        const n = messages[j]
        if (isPureToolResult(n)) { j++; continue }
        if (!isTraceAssistantMsg(n)) break
        chain.push(n)
        j++
      }
      const next = messages[j]
      if (next && canAttachTraceToMessage(next) && !isTraceAssistantMsg(next)) {
        out.push({ kind: 'turn', msg: next, trace: chain })
        i = j + 1
      } else {
        out.push({ kind: 'chain', messages: chain })
        i = j
      }
    } else {
      out.push({ kind: 'msg', msg: m })
      i++
    }
  }
  return out
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
  background: var(--code-bg); padding: 1px 5px; border-radius: 3px;
  font-family: 'SF Mono', Menlo, 'Courier New', monospace; font-size: 0.88em;
}
.markdown pre { margin: 8px 0; border-radius: 6px; overflow-x: auto; background: var(--bg-secondary); padding: 10px 12px; }
.markdown pre code { background: none; padding: 0; font-size: 0.85em; color: var(--code-text); }
.markdown img { max-width: 100%; }
.markdown img.md-local-img { display: block; max-height: 400px; border-radius: 6px; margin: 8px 0; object-fit: contain; }
.markdown blockquote {
  margin: 6px 0; padding: 4px 12px; border-left: 3px solid var(--text-faint); color: var(--text-secondary);
}
.markdown .md-table-frame { position: relative; max-width: 100%; margin: 8px 0; overflow-x: auto; border: 1px solid var(--border-medium); border-radius: 7px; -webkit-overflow-scrolling: touch; }
.markdown table { border-collapse: collapse; width: max-content; min-width: 100%; max-width: none; margin: 0; font-size: 0.9em; table-layout: auto; }
.markdown th, .markdown td { border: 1px solid var(--border-medium); padding: 5px 10px; text-align: left; vertical-align: top; }
.markdown .md-col-compact { white-space: nowrap; width: 1%; }
.markdown .md-col-wide { min-width: 14rem; max-width: 34rem; white-space: normal; overflow-wrap: break-word; }
.markdown th { background: rgba(255,255,255,0.05); font-weight: 600; }
.markdown .md-table-expand { position: sticky; left: calc(100% - 32px); bottom: 6px; width: 26px; height: 26px; margin: 0 6px 6px 0; border: 1px solid var(--border-medium); border-radius: 6px; background: rgba(20,24,30,0.94); color: var(--text-secondary); cursor: zoom-in; font-size: 15px; line-height: 1; }
.markdown .md-table-expand:hover { color: var(--text-primary); background: var(--bg-surface); }
.md-table-modal { position: fixed; inset: 0; z-index: 220; display: flex; flex-direction: column; background: rgba(5,7,10,0.96); }
.md-table-modal-bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border-medium); color: var(--text-secondary); font-size: 12px; }
.md-table-modal-body { flex: 1; overflow: auto; padding: 16px; -webkit-overflow-scrolling: touch; }
.md-table-modal-body table { border-collapse: collapse; width: max-content; min-width: 100%; font-size: 14px; }
.md-table-modal-body th, .md-table-modal-body td { border: 1px solid var(--border-medium); padding: 8px 12px; text-align: left; vertical-align: top; }
.md-table-modal-body th { background: var(--bg-surface); position: sticky; top: 0; }
.md-table-modal-body .md-col-compact { white-space: nowrap; width: 1%; }
.md-table-modal-body .md-col-wide { min-width: 18rem; max-width: 42rem; white-space: normal; overflow-wrap: break-word; }
.markdown a { color: var(--link); text-decoration: none; }
.markdown a:hover { text-decoration: underline; }
.feather-path { color: var(--link); text-decoration: none; cursor: pointer; }
.feather-path:hover { text-decoration: underline; }
.markdown img { max-width: 100%; border-radius: 6px; }
.markdown hr { border: none; border-top: 1px solid var(--border-medium); margin: 12px 0; }
.markdown strong { font-weight: 600; }

/* Copy button */
.copy-btn {
  position: absolute; top: 6px; right: 6px;
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
  color: var(--text-secondary); font-size: 11px; padding: 2px 8px; border-radius: 4px;
  cursor: pointer; opacity: 0; transition: opacity 0.15s;
  font-family: -apple-system, system-ui, sans-serif;
}
pre:hover .copy-btn { opacity: 1; }
.copy-btn:hover { background: rgba(255,255,255,0.2); color: var(--text-primary); }

/* Typing indicator bounce */
@keyframes typing-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* Star button - show on hover */
.star-btn { -webkit-tap-highlight-color: transparent; }
div:hover > div > .star-btn { opacity: 0.6 !important; }
.star-btn:hover { opacity: 1 !important; }

/* Execution details: quiet at rest, full fidelity on demand */
.work-log { width: 100%; margin: 0 0 4px; }
.work-log > summary::-webkit-details-marker { display: none; }
.work-log-summary {
  display: flex; align-items: center; gap: 5px; width: max-content; min-height: 28px;
  padding: 0 2px; border: none; background: transparent; color: var(--text-faint);
  font-size: 11px; cursor: pointer; list-style: none; user-select: none;
  transition: color 120ms ease;
}
.work-log-summary:hover { color: var(--text-secondary); }
.work-log-summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.work-log-chevron { display: inline-block; transition: transform 120ms ease; }
.work-log[open] .work-log-chevron { transform: rotate(90deg); }
.work-log-issue { display: inline-flex; align-items: center; gap: 4px; color: var(--warning); }
.work-log-issue-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.work-log-detail {
  margin-top: 6px; padding: 10px 12px; border: 1px solid var(--border-subtle);
  border-radius: 9px; background: var(--bg-secondary); font-size: 13px; line-height: 1.5;
}
.work-log-meta { margin-bottom: 8px; color: var(--text-ghost); font-size: 10px; }
.work-log-reasoning {
  margin: 2px 0 4px; padding-left: 8px; border-left: 1px solid rgba(192,132,252,0.3);
  color: var(--text-secondary); font-size: 12px; line-height: 1.4;
}
.work-log-reasoning p { margin: 0 0 4px; }
.work-log-reasoning p:last-child { margin-bottom: 0; }
.work-log-reasoning ul, .work-log-reasoning ol { margin: 2px 0 4px; }

/* highlight.js theme — uses CSS variables for theme switching */
.hljs { color: var(--code-text); }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: var(--hljs-keyword); }
.hljs-function .hljs-keyword { color: var(--hljs-keyword); }
.hljs-string, .hljs-attr { color: var(--hljs-string); }
.hljs-number, .hljs-meta { color: var(--hljs-number); }
.hljs-comment, .hljs-quote { color: var(--hljs-comment); font-style: italic; }
.hljs-title, .hljs-title.function_ { color: var(--hljs-function); }
.hljs-built_in { color: var(--hljs-builtin); }
.hljs-type, .hljs-class .hljs-title { color: var(--hljs-builtin); }
.hljs-variable, .hljs-template-variable { color: var(--hljs-builtin); }
.hljs-name { color: var(--hljs-name); }
.hljs-selector-class { color: var(--hljs-name); }
.hljs-addition { color: var(--hljs-addition); background: var(--hljs-addition-bg); }
.hljs-deletion { color: var(--hljs-deletion); background: var(--hljs-deletion-bg); }
.hljs-regexp, .hljs-symbol { color: var(--hljs-regexp); }
.hljs-params { color: var(--code-text); }
.hljs-property { color: var(--hljs-property); }
`

// ── Component ───────────────────────────────────────────────────────────────

type MessageViewTodo = {
  phases: Array<{ name: string; tasks: Array<{ content: string; status: string }> }>
  completed: number
  total: number
  active: string | null
}
type MessageViewSubagent = {
  id: string
  agent: string
  status: string
  description?: string
  intent?: string
  resolvedModel?: string
  toolCount?: number
  requests?: number
  tokens?: number
  durationMs?: number
}

type MessageViewJob = {
  id: string
  type: string
  status: string
  label?: string
}

type MessageViewRuntime = {
  modelProvider?: string
  modelId?: string
  modelApi?: string
  thinkingLevel?: string
  serviceTiers?: Record<string, string | null>
  contextTokens?: number
  contextWindow?: number
  contextPercent?: number
}


type MessageViewProps = {
  messages: Message[]
  loading: boolean
  hasMore?: boolean
  loadingMore?: boolean
  onLoadEarlier?: () => void
  onAnswer?: (text: string) => void
  onKeys?: (keys: string[]) => void
  starred?: Set<string>
  onToggleStar?: (uuid: string) => void
  onViewRaw?: (msg: Message) => void
  working?: boolean
  statusText?: string | null
  intentHistory?: string[]
  assistantStream?: { text: string; ended: boolean } | null
  todo?: MessageViewTodo | null
  notice?: { kind: string; text: string } | null
  approval?: { toolName: string; approvalMode: string; reason?: string } | null
  subagents?: MessageViewSubagent[]
  jobs?: MessageViewJob[]
  runtime?: MessageViewRuntime | null
}

export function MessageView(props: MessageViewProps) {
  const [lightbox, setLightbox] = createSignal<string | null>(null)
  const [pdfViewer, setPdfViewer] = createSignal<string | null>(null)
  const [expandedTable, setExpandedTable] = createSignal<string | null>(null)
  let tableReturnFocus: HTMLElement | null = null
  let tableModal: HTMLDivElement | undefined

  function openExpandedTable(html: string) {
    tableReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setExpandedTable(html)
  }

  function closeExpandedTable() {
    setExpandedTable(null)
    queueMicrotask(() => tableReturnFocus?.focus())
  }

  function handleTableModalKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); closeExpandedTable(); return }
    if (event.key !== 'Tab' || !tableModal) return
    const focusable = Array.from(tableModal.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])'))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  // Pair tool_use blocks with their matching tool_result so they render as one unit.
  const toolResultsById = createMemo(() => {
    const map = new Map<string, ContentBlock>()
    for (const m of props.messages) {
      if (!m.content) continue
      for (const b of m.content) {
        if (b.type === 'tool_result' && b.tool_use_id) map.set(b.tool_use_id, b)
      }
    }
    return map
  })
  const getResult = (id: string) => toolResultsById().get(id)

  function renderWorkLog(messages: Message[]) {
    const blocks = messages.flatMap(message => message.content || [])
    const traceBlocks = blocks.filter(block =>
      block.type === 'thinking' || block.type === 'tool_use' || block.type === 'tool_result'
    )
    const errorCount = traceBlocks.filter(block =>
      block.type === 'tool_result' ? !!block.is_error :
      block.type === 'tool_use' && block.id ? !!getResult(block.id)?.is_error : false
    ).length
    const last = messages[messages.length - 1]
    return (
      <details class="work-log">
        <summary class="work-log-summary" data-testid="work-log-summary">
          <span class="work-log-chevron">›</span>
          <span style={{ 'font-weight': '600' }}>Details</span>
          {errorCount > 0 && (
            <span class="work-log-issue">
              <span class="work-log-issue-dot" />
              {errorCount} issue{errorCount === 1 ? '' : 's'}
            </span>
          )}
        </summary>
        <div class="work-log-detail" data-testid="work-log-detail">
          <div class="work-log-meta">
            {traceBlocks.length} execution step{traceBlocks.length === 1 ? '' : 's'} · {formatTime(last.timestamp)}
          </div>
          <For each={messages}>{(message) => (
            <For each={message.content}>{(block) => {
              if (block.type === 'thinking' && block.thinking) {
                return (
                  <div
                    class="markdown work-log-reasoning"
                    innerHTML={renderMarkdown(block.thinking)}
                    ref={(element) => queueMicrotask(() => enhanceMarkdown(element, setLightbox, openExpandedTable))}
                  />
                )
              }
              return renderBlock(block, setLightbox, getResult, openExpandedTable)
            }}</For>
          )}</For>
        </div>
      </details>
    )
  }

  // A message whose visible content is only tool_result gets folded into the tool_use above — skip it.
  function isPureToolResultMsg(m: Message): boolean {
    if (!m.content || m.content.length === 0) return false
    return m.content.every(b =>
      b.type === 'tool_result' ||
      (b.type === 'text' && !b.text?.trim())
    ) && m.content.some(b => b.type === 'tool_result')
  }
  const renderItems = createMemo(() => buildRenderItems(props.messages, isPureToolResultMsg))


  let scrollRef: HTMLDivElement | undefined
  const [pinned, setPinned] = createSignal(true) // pinned to bottom by default
  const [unreadCount, setUnreadCount] = createSignal(0)

  function onScroll() {
    if (!scrollRef) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef
    const near = scrollHeight - scrollTop - clientHeight < 80
    setPinned(near)
    if (near) setUnreadCount(0)
  }

  function scrollToBottom() {
    scrollRef?.scrollTo({ top: scrollRef!.scrollHeight, behavior: 'smooth' })
    setUnreadCount(0)
  }

  let prevMsgLen = props.messages.length
  let prevStreamText = props.assistantStream?.text || ''

  createEffect(() => {
    const len = props.messages.length
    const streamText = props.assistantStream?.text || ''
    const delta = len - prevMsgLen
    const streamChanged = streamText !== prevStreamText
    prevMsgLen = len
    prevStreamText = streamText
    if (pinned() && (delta !== 0 || streamChanged)) {
      requestAnimationFrame(() => scrollRef?.scrollTo({ top: scrollRef!.scrollHeight }))
    } else if (delta > 0) {
      setUnreadCount(c => c + delta)
    }
  })

  return (
    <div style={{ position: 'relative', height: '100%' }}>
    <div ref={scrollRef} onScroll={onScroll} onClick={handleCopyClick} style={{ height: '100%', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', padding: '16px', 'padding-bottom': '80px' }}>
      <style>{markdownCSS}</style>
      <Show when={expandedTable()}>
        <div ref={tableModal} class="md-table-modal" role="dialog" aria-modal="true" aria-label="Expanded table" onKeyDown={handleTableModalKeydown}>
          <div class="md-table-modal-bar">
            <span>Table</span>
            <button ref={(element) => queueMicrotask(() => element.focus())} aria-label="Close expanded table" onClick={closeExpandedTable} style={{ background: 'none', border: 'none', color: 'var(--text-primary)', 'font-size': '24px', cursor: 'pointer', padding: '2px 8px' }}>&times;</button>
          </div>
          <div class="md-table-modal-body" innerHTML={expandedTable()!} ref={(element) => queueMicrotask(() => { fixLinks(element); fixImages(element, setLightbox); linkifyPaths(element) })} />
        </div>
      </Show>
      <Show when={props.loading}>
        <div style={{ color: 'var(--text-dim)', 'text-align': 'center', padding: '40px' }}>Loading...</div>
      </Show>
      <Show when={props.hasMore && !props.loading}>
        <div style={{ 'text-align': 'center', padding: '12px' }}>
          <button onClick={() => props.onLoadEarlier?.()} disabled={props.loadingMore}
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-medium)', color: 'var(--link)', padding: '6px 16px', 'border-radius': '6px', 'font-size': '12px', cursor: props.loadingMore ? 'wait' : 'pointer' }}>
            {props.loadingMore ? 'Loading...' : 'Load earlier messages'}
          </button>
        </div>
      </Show>
      {/* Lightbox with pinch-to-zoom */}
      <Show when={lightbox()}>
        {(() => {
          const [scale, setScale] = createSignal(1)
          const [tx, setTx] = createSignal(0)
          const [ty, setTy] = createSignal(0)
          let startDist = 0
          let startScale = 1
          let startTx = 0
          let startTy = 0
          let startMidX = 0
          let startMidY = 0
          let lastTap = 0
          let moved = false

          function dist(t: TouchList) {
            const dx = t[1].clientX - t[0].clientX
            const dy = t[1].clientY - t[0].clientY
            return Math.sqrt(dx * dx + dy * dy)
          }

          function onTouch(e: TouchEvent) {
            if (e.type === 'touchstart') {
              moved = false
              if (e.touches.length === 2) {
                e.preventDefault()
                startDist = dist(e.touches)
                startScale = scale()
                startTx = tx()
                startTy = ty()
                startMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2
                startMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2
              } else if (e.touches.length === 1 && scale() > 1) {
                e.preventDefault()
                startTx = tx()
                startTy = ty()
                startMidX = e.touches[0].clientX
                startMidY = e.touches[0].clientY
              }
            } else if (e.type === 'touchmove') {
              if (e.touches.length === 2) {
                e.preventDefault()
                moved = true
                const newScale = Math.min(5, Math.max(1, startScale * (dist(e.touches) / startDist)))
                setScale(newScale)
                const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2
                const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2
                setTx(startTx + midX - startMidX)
                setTy(startTy + midY - startMidY)
              } else if (e.touches.length === 1 && scale() > 1) {
                e.preventDefault()
                moved = true
                setTx(startTx + e.touches[0].clientX - startMidX)
                setTy(startTy + e.touches[0].clientY - startMidY)
              }
            } else if (e.type === 'touchend') {
              // Snap back if scale went below 1
              if (scale() <= 1) { setScale(1); setTx(0); setTy(0) }
            }
          }

          function onClick(e: MouseEvent) {
            // Double-tap to zoom
            const now = Date.now()
            if (now - lastTap < 300) {
              e.stopPropagation()
              if (scale() > 1) { setScale(1); setTx(0); setTy(0) }
              else { setScale(2.5) }
              lastTap = 0
              return
            }
            lastTap = now
            // Single tap close (with delay to detect double-tap)
            if (!moved && scale() <= 1) {
              setTimeout(() => { if (Date.now() - lastTap >= 280) setLightbox(null) }, 300)
            }
          }

          return (
            <div
              onClick={onClick}
              onTouchStart={onTouch} onTouchMove={onTouch} onTouchEnd={onTouch}
              style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.85)', 'z-index': '200', display: 'flex', 'align-items': 'center', 'justify-content': 'center', cursor: scale() > 1 ? 'grab' : 'zoom-out', 'touch-action': 'none' }}
            >
              <img src={lightbox()!} style={{ 'max-width': '95vw', 'max-height': '95vh', 'object-fit': 'contain', 'border-radius': '8px', transform: `translate(${tx()}px, ${ty()}px) scale(${scale()})`, 'transform-origin': 'center center', transition: scale() === 1 ? 'transform 0.2s ease' : 'none', 'pointer-events': 'none' }} draggable={false} />
            </div>
          )
        })()}
      </Show>

      {/* PDF viewer modal */}
      <Show when={pdfViewer()}>
        <div style={{ position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.92)', 'z-index': '200', display: 'flex', 'flex-direction': 'column' }}>
          <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', padding: '8px 12px', background: 'var(--bg-secondary)' }}>
            <span style={{ color: 'var(--text-secondary)', 'font-size': '13px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', flex: '1' }}>{pdfViewer()!.split('/').pop()}</span>
            <button onClick={() => setPdfViewer(null)} style={{ background: 'none', border: 'none', color: 'var(--text-primary)', 'font-size': '24px', cursor: 'pointer', padding: '4px 8px', 'line-height': '1' }}>&times;</button>
          </div>
          <iframe src={pdfViewer()!} style={{ flex: '1', border: 'none', width: '100%', background: '#fff' }} />
        </div>
      </Show>

      <For each={renderItems()}>{(item) => {
        if (item.kind === 'chain') {
          if (!props.working || item !== renderItems().at(-1)) return null
          return (
            <div class="msg-row" data-testid="live-work-turn" style={{ display: 'flex', 'justify-content': 'flex-start', 'margin-bottom': '12px' }}>
              <div class="asst-bubble" style={{
                'max-width': '100%', padding: '6px 12px',
                'border-radius': '12px', background: '#1e1e1e',
                border: '1px solid rgba(255,255,255,0.06)',
                color: 'var(--text-primary)', overflow: 'hidden',
              }}>
                {renderWorkLog(item.messages)}
              </div>
            </div>
          )
        }

        const msg = item.msg
        const turnTrace = item.kind === 'turn' ? item.trace : []
        // Extract images from text blocks
        const textBlock = msg.content?.find(b => b.type === 'text' && b.text)
        const { cleanText, images, files } = textBlock?.text ? extractImages(textBlock.text) : { cleanText: textBlock?.text || '', images: [], files: [] }
        const hasAttachments = images.length > 0 || files.length > 0
        const inlineTraceBlocks = (msg.content || []).filter(block =>
          block.type === 'thinking' ||
          block.type === 'tool_result' ||
          (block.type === 'tool_use' && !isQuestionBlock(block))
        )
        const workLogMessages = inlineTraceBlocks.length > 0
          ? [...turnTrace, { ...msg, content: inlineTraceBlocks }]
          : turnTrace

        // Metadata row \u2014 rendered INSIDE the bubble with a subtle top-border divider,
        // matching pi-dashboard's style: timestamp on the left, action icons on the right.
        const copyMsgText = () => {
          const txt = (msg.content || []).map(b => b.type === 'text' ? (b.text || '') : '').join('\n').trim()
          if (txt) navigator.clipboard?.writeText(txt).catch(() => {})
        }
        const metadataRow = (
          <div class="msg-meta" style={{
            display: 'flex', 'align-items': 'center', 'justify-content': 'space-between',
            gap: '8px', 'margin-top': '8px', 'padding-top': '6px',
            'border-top': '1px solid rgba(255,255,255,0.06)',
            'font-size': '11px', color: 'var(--text-faint)',
          }}>
            <span>{formatTime(msg.timestamp)}</span>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
              {msg.role === 'user' && msg.delivery && (
                <span style={{ color: msg.delivery === 'delivered' ? 'var(--success)' : 'var(--text-dim)' }}>
                  {msg.delivery === 'delivered' ? '\u2713\u2713' : '\u2713'}
                </span>
              )}
              <button class="msg-action" title="Copy message" onClick={copyMsgText}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--text-faint)', display: 'inline-flex', 'align-items': 'center', opacity: '0.6' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
              <button class="msg-action" title="View raw" onClick={() => props.onViewRaw?.(msg)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: 'var(--text-faint)', display: 'inline-flex', 'align-items': 'center', opacity: '0.6' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              </button>
              {!msg.uuid.startsWith('optimistic-') && (
                <button class="msg-action" title={props.starred?.has(msg.uuid) ? 'Unstar' : 'Star'} onClick={() => props.onToggleStar?.(msg.uuid)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: props.starred?.has(msg.uuid) ? 'var(--warning)' : 'var(--text-faint)', opacity: props.starred?.has(msg.uuid) ? '1' : '0.6', display: 'inline-flex', 'align-items': 'center' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill={props.starred?.has(msg.uuid) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </button>
              )}
            </div>
          </div>
        )

        // User message: single blue-tinted bubble right-aligned; metadata INSIDE the bubble.
        if (msg.role === 'user') {
          return (
            <div class="msg-row" style={{ display: 'flex', 'justify-content': 'flex-end', 'margin-bottom': '12px' }}>
              <div style={{
                'max-width': '70%', padding: '10px 14px 8px',
                'border-radius': '12px',
                background: '#1e1e1e',
                border: '1px solid rgba(96, 165, 250, 0.22)',
                color: 'var(--text-primary)', overflow: 'hidden',
                'font-size': '14px', 'line-height': '1.5', 'word-break': 'break-word',
              }}>
                <For each={images}>{(src) => (
                  <img src={localFileUrl(src)!} onClick={() => setLightbox(localFileUrl(src)!)} onError={(e) => replaceImageWithPathLink(e.currentTarget, src)} style={{ 'max-width': '100%', 'max-height': '300px', 'border-radius': '6px', 'margin-bottom': '4px', cursor: 'zoom-in', display: 'block' }} />
                )}</For>
                <For each={files}>{(f) => {
                  const isPdf = f.name.toLowerCase().endsWith('.pdf')
                  const url = localFileUrl(f.path)!
                  return (
                    <a href={url} target={isPdf ? undefined : '_blank'} rel="noopener"
                      onClick={(e) => { if (isPdf) { e.preventDefault(); setPdfViewer(url) } }}
                      style={{ display: 'flex', 'align-items': 'center', gap: '6px', padding: '6px 10px', margin: '2px 0', background: 'rgba(255,255,255,0.05)', 'border-radius': '8px', 'text-decoration': 'none', color: 'var(--link)', 'font-size': '12px' }}>
                      <span style={{ 'font-size': '16px' }}>{isPdf ? '\uD83D\uDCC4' : '\uD83D\uDCCE'}</span>
                      <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{f.name}</span>
                    </a>
                  )
                }}</For>
                {(() => {
                  const display = hasAttachments ? cleanText : (textBlock?.text || '')
                  return display ? <div class="markdown" innerHTML={renderMarkdown(display)} ref={(el) => queueMicrotask(() => enhanceMarkdown(el, setLightbox, openExpandedTable))} /> : null
                })()}
                {metadataRow}
              </div>
            </div>
          )
        }

        // Assistant message: single wide bubble containing all blocks (text, tool_use, thinking) + metadata inside.
        return (
          <div class="msg-row" style={{ display: 'flex', 'justify-content': 'flex-start', 'margin-bottom': '12px' }}>
            <div class="asst-bubble" style={{
              'max-width': '100%', padding: '10px 14px 8px',
              'border-radius': '12px',
              background: '#1e1e1e',
              border: '1px solid rgba(255,255,255,0.06)',
              color: 'var(--text-primary)', overflow: 'hidden',
              'font-size': '14px', 'line-height': '1.55', 'word-break': 'break-word',
            }}>
              {workLogMessages.length > 0 ? renderWorkLog(workLogMessages) : null}
              <For each={msg.content}>{(block) => {
                if (
                  block.type === 'thinking' ||
                  block.type === 'tool_result' ||
                  (block.type === 'tool_use' && !isQuestionBlock(block))
                ) return null
                if (block.type === 'text' && block.text) {
                  const { cleanText: bText, images: bImgs, files: bFiles } = extractImages(block.text)
                  const hasAny = bImgs.length > 0 || bFiles.length > 0 || bText.trim().length > 0
                  if (!hasAny) return null
                  return (
                    <div>
                      <For each={bImgs}>{(src) => (
                        <img src={localFileUrl(src)!} onClick={() => setLightbox(localFileUrl(src)!)} onError={(e) => replaceImageWithPathLink(e.currentTarget, src)} style={{ 'max-width': '100%', 'max-height': '300px', 'border-radius': '8px', 'margin-bottom': '4px', cursor: 'zoom-in', display: 'block' }} />
                      )}</For>
                      <For each={bFiles}>{(f) => {
                        const isPdf = f.name.toLowerCase().endsWith('.pdf')
                        const url = localFileUrl(f.path)!
                        return (
                          <a href={url} target={isPdf ? undefined : '_blank'} rel="noopener"
                            onClick={(e) => { if (isPdf) { e.preventDefault(); setPdfViewer(url) } }}
                            style={{ display: 'flex', 'align-items': 'center', gap: '6px', padding: '6px 10px', margin: '2px 0', background: 'rgba(255,255,255,0.05)', 'border-radius': '8px', 'text-decoration': 'none', color: 'var(--link)', 'font-size': '12px' }}>
                            <span style={{ 'font-size': '16px' }}>{isPdf ? '📄' : '📎'}</span>
                            <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{f.name}</span>
                          </a>
                        )
                      }}</For>
                      {bText.trim() && (
                        <div class="markdown" innerHTML={renderMarkdown(bText)} ref={(el) => queueMicrotask(() => enhanceMarkdown(el, setLightbox, openExpandedTable))} />
                      )}
                    </div>
                  )
                }
                if (isQuestionBlock(block)) {
                  const rawQuestions = Array.isArray(block.input?.questions)
                    ? block.input.questions
                    : [{ id: 'question', question: block.input?.question || 'The assistant needs your input.', options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Continue' }] }]
                  return (
                    <For each={rawQuestions}>{(question, questionIndex) => {
                      const options = Array.isArray(question.options) ? question.options : []
                      const answered = block.id ? !!getResult(block.id) : false
                      return (
                        <div style={{ margin: '6px 0', background: 'rgba(168, 85, 247, 0.06)', border: '1px solid rgba(168, 85, 247, 0.25)', 'border-left': '2px solid #a855f7', 'border-radius': '10px', padding: '12px' }}>
                          <div style={{ color: '#a855f7', 'font-size': '10px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.08em', 'margin-bottom': '6px' }}>{answered ? 'Answered' : question.header || 'Question'}</div>
                          <div style={{ color: 'var(--text-primary)', 'font-size': '14px', 'margin-bottom': '10px' }}>{question.question}</div>
                          <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
                            <For each={options}>{(option, optionIndex) => (
                              <button
                                onClick={() => {
                                  if (answered) return
                                  if (!props.onKeys) {
                                    props.onAnswer?.(rawQuestions.length > 1 ? `${question.id}: ${option.label}` : option.label)
                                    return
                                  }
                                  props.onKeys(['Home', ...Array(optionIndex()).fill('Down'), question.multi ? 'Space' : 'Enter'])
                                }}
                                title={option.description || undefined}
                                disabled={answered}
                                style={{ background: 'var(--border-medium)', border: '1px solid var(--text-dim)', color: 'var(--text-primary)', padding: '5px 12px', 'border-radius': '6px', 'font-size': '12px', cursor: answered ? 'default' : 'pointer', 'text-align': 'left', opacity: answered ? '0.55' : '1' }}
                              >
                                <span>{option.label}</span>
                                <Show when={option.description}><span style={{ display: 'block', color: 'var(--text-muted)', 'font-size': '10px', 'margin-top': '2px' }}>{option.description}</span></Show>
                              </button>
                            )}</For>
                            <Show when={question.multi}>
                              <button
                                disabled={answered}
                                onClick={() => props.onKeys?.(['End', 'Enter'])}
                                style={{ background: 'var(--accent)', border: '1px solid var(--accent)', color: '#fff', padding: '5px 12px', 'border-radius': '6px', 'font-size': '12px', cursor: 'pointer' }}
                              >Done</button>
                            </Show>
                          </div>
                          <Show when={question.multi}><div style={{ color: 'var(--text-muted)', 'font-size': '10px', 'margin-top': '7px' }}>Multiple selections allowed</div></Show>
                          <Show when={questionIndex() < rawQuestions.length - 1}><div style={{ height: '6px' }} /></Show>
                        </div>
                      )
                    }}</For>
                  )
                }
                // thinking, tool_use, tool_result — flat rendering via renderBlock (inside bubble)
                return renderBlock(block, setLightbox, getResult, openExpandedTable)
              }}</For>
              {metadataRow}
            </div>
          </div>
        )
      }}</For>

      <Show when={props.approval}>
        <div data-testid="omp-approval" role="alert" style={{ margin: '0 0 10px', padding: '11px 12px', 'border-radius': '10px', border: '1px solid var(--warning)', background: 'rgba(245,158,11,0.08)' }}>
          <div style={{ color: 'var(--warning)', 'font-size': '10px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.08em' }}>Approval required</div>
          <div style={{ color: 'var(--text-primary)', 'font-size': '13px', 'margin-top': '4px' }}>{props.approval!.toolName}</div>
          <Show when={props.approval!.reason}><div style={{ color: 'var(--text-muted)', 'font-size': '11px', 'margin-top': '3px', 'white-space': 'pre-wrap' }}>{props.approval!.reason}</div></Show>
          <div style={{ display: 'flex', gap: '7px', 'margin-top': '9px' }}>
            <button onClick={() => props.onKeys?.(['Enter'])} style={{ background: 'var(--success)', color: '#07140b', border: 'none', padding: '5px 13px', 'border-radius': '6px', 'font-size': '12px', 'font-weight': '600', cursor: 'pointer' }}>Approve</button>
            <button onClick={() => props.onKeys?.(['Escape'])} style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-medium)', padding: '5px 13px', 'border-radius': '6px', 'font-size': '12px', cursor: 'pointer' }}>Reject</button>
          </div>
        </div>
      </Show>

      <Show when={props.runtime}>
        <details data-testid="omp-runtime" style={{ margin: '0 0 10px', padding: '0 11px', 'border-radius': '10px', border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}>
          <summary style={{ padding: '7px 0', cursor: 'pointer', color: 'var(--text-muted)', 'font-size': '11px' }}>
            {[props.runtime!.modelProvider, props.runtime!.modelId].filter(Boolean).join('/') || 'OMP session'}
            <Show when={props.runtime!.thinkingLevel}><span> · {props.runtime!.thinkingLevel}</span></Show>
            <Show when={props.runtime!.contextPercent !== undefined}><span> · {Math.round(props.runtime!.contextPercent!)}% context</span></Show>
          </summary>
          <div style={{ padding: '0 0 8px', color: 'var(--text-muted)', 'font-size': '10px', 'line-height': '1.55' }}>
            <Show when={props.runtime!.modelApi}><div>API · {props.runtime!.modelApi}</div></Show>
            <Show when={props.runtime!.contextTokens !== undefined && props.runtime!.contextWindow !== undefined}>
              <div>Context · {props.runtime!.contextTokens!.toLocaleString()} / {props.runtime!.contextWindow!.toLocaleString()} tokens</div>
            </Show>
            <Show when={Object.keys(props.runtime!.serviceTiers || {}).length}>
              <div>Service · {Object.entries(props.runtime!.serviceTiers || {}).map(([family, tier]) => `${family}: ${tier || 'default'}`).join(' · ')}</div>
            </Show>
          </div>
        </details>
      </Show>

      <Show when={(props.subagents?.length || 0) > 0}>
        <details data-testid="omp-subagents" open={(props.subagents || []).some(agent => agent.status === 'running' || agent.status === 'started')} style={{ margin: '0 0 10px', padding: '0 11px', 'border-radius': '10px', border: '1px solid var(--border-medium)', background: 'var(--bg-surface)' }}>
          <summary style={{ padding: '8px 0', cursor: 'pointer', color: 'var(--text-secondary)', 'font-size': '12px', 'font-weight': '600' }}>
            Agents · {(props.subagents || []).filter(agent => agent.status === 'running' || agent.status === 'started').length} running
          </summary>
          <div style={{ padding: '0 0 8px' }}>
            <For each={props.subagents || []}>{(agent) => (
              <div style={{ padding: '5px 0', 'border-top': '1px solid var(--border-subtle)', 'font-size': '11px' }}>
                <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px' }}>
                  <span style={{ color: 'var(--text-primary)', 'font-weight': '600' }}>{agent.agent}</span>
                  <span style={{ color: agent.status === 'failed' ? 'var(--error)' : agent.status === 'running' || agent.status === 'started' ? 'var(--accent)' : 'var(--text-muted)' }}>{agent.status}</span>
                </div>
                <Show when={agent.description}><div style={{ color: 'var(--text-secondary)', 'margin-top': '2px' }}>{agent.description}</div></Show>
                <Show when={agent.intent}><div style={{ color: 'var(--text-muted)', 'margin-top': '2px' }}>{agent.intent}</div></Show>
                <div style={{ color: 'var(--text-faint)', 'font-size': '10px', 'margin-top': '2px' }}>
                  {[agent.resolvedModel, agent.toolCount !== undefined ? `${agent.toolCount} steps` : '', agent.tokens !== undefined ? `${agent.tokens.toLocaleString()} tokens` : ''].filter(Boolean).join(' · ')}
                </div>
              </div>
            )}</For>
          </div>
        </details>
      </Show>

      <Show when={(props.jobs?.length || 0) > 0}>
        <details data-testid="omp-jobs" style={{ margin: '0 0 10px', padding: '0 11px', 'border-radius': '10px', border: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}>
          <summary style={{ padding: '7px 0', cursor: 'pointer', color: 'var(--text-muted)', 'font-size': '11px' }}>
            Background jobs · {(props.jobs || []).filter(job => job.status === 'running').length} running
          </summary>
          <div style={{ padding: '0 0 7px' }}>
            <For each={props.jobs || []}>{(job) => (
              <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '8px', padding: '3px 0', color: 'var(--text-muted)', 'font-size': '10px' }}>
                <span>{job.label || job.type}</span><span>{job.status}</span>
              </div>
            )}</For>
          </div>
        </details>
      </Show>

      <Show when={props.notice}>
        <div role="status" style={{ margin: '0 0 10px', padding: '8px 11px', 'border-radius': '9px', border: '1px solid var(--warning)', background: 'rgba(245,158,11,0.08)', color: 'var(--warning)', 'font-size': '12px' }}>
          {props.notice!.text}
        </div>
      </Show>

      <Show when={props.todo}>
        <details open={props.working} style={{ margin: '0 0 10px', padding: '0 11px', 'border-radius': '10px', border: '1px solid var(--border-medium)', background: 'var(--bg-surface)' }}>
          <summary style={{ padding: '8px 0', cursor: 'pointer', color: 'var(--text-secondary)', 'font-size': '12px', 'font-weight': '600' }}>
            Todo · {props.todo!.completed}/{props.todo!.total}
            <Show when={props.todo!.active}><span style={{ color: 'var(--text-muted)', 'font-weight': '400' }}> · {props.todo!.active}</span></Show>
          </summary>
          <div style={{ padding: '0 0 9px' }}>
            <For each={props.todo!.phases}>{(phase) => (
              <div style={{ 'margin-top': '7px' }}>
                <div style={{ color: 'var(--text-muted)', 'font-size': '10px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.06em', 'margin-bottom': '3px' }}>{phase.name}</div>
                <For each={phase.tasks}>{(task) => (
                  <div style={{ display: 'flex', gap: '7px', padding: '2px 0', color: task.status === 'completed' ? 'var(--text-dim)' : task.status === 'in_progress' ? 'var(--text-primary)' : 'var(--text-secondary)', 'font-size': '11px', 'text-decoration': task.status === 'abandoned' ? 'line-through' : 'none' }}>
                    <span style={{ color: task.status === 'completed' ? 'var(--success)' : task.status === 'in_progress' ? 'var(--accent)' : task.status === 'blocked' ? 'var(--warning)' : 'var(--text-faint)', width: '12px', 'flex-shrink': '0' }}>
                      {task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '●' : task.status === 'blocked' ? '!' : task.status === 'abandoned' ? '×' : '○'}
                    </span>
                    <span>{task.content}</span>
                  </div>
                )}</For>
              </div>
            )}</For>
          </div>
        </details>
      </Show>

      <Show when={props.assistantStream?.text}>
        <div data-testid="assistant-stream" aria-live="polite" style={{ display: 'flex', 'justify-content': 'flex-start', 'margin-bottom': '10px' }}>
          <div style={{ 'max-width': '100%', padding: '10px 14px', 'border-radius': '12px', background: '#1e1e1e', border: '1px solid rgba(255,255,255,0.06)', color: 'var(--text-primary)', 'font-size': '14px', 'line-height': '1.55', 'white-space': 'pre-wrap', 'word-break': 'break-word' }}>
            {props.assistantStream!.text}<span aria-hidden="true" style={{ display: 'inline-block', width: '1px', height: '1em', background: 'var(--text-secondary)', 'margin-left': '2px', 'vertical-align': 'text-bottom', opacity: props.assistantStream!.ended ? '0.35' : '0.9' }} />
          </div>
        </div>
      </Show>

      <Show when={props.working}>
        <div style={{ display: 'flex', 'align-items': 'flex-start', 'margin-bottom': '10px' }}>
          <div role="status" aria-live="polite" style={{ padding: '9px 12px', 'border-radius': '16px 16px 16px 4px', background: 'var(--bg-surface)', display: 'flex', gap: '6px', 'align-items': 'center', 'max-width': '92%' }}>
            <span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: 'var(--text-secondary)', 'animation': 'typing-bounce 1.2s ease-in-out infinite', 'flex-shrink': '0' }} />
            <span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: 'var(--text-secondary)', 'animation': 'typing-bounce 1.2s ease-in-out 0.2s infinite', 'flex-shrink': '0' }} />
            <span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: 'var(--text-secondary)', 'animation': 'typing-bounce 1.2s ease-in-out 0.4s infinite', 'flex-shrink': '0' }} />
            <Show when={props.statusText}>
              <Show when={(props.intentHistory?.length || 0) > 1} fallback={<span style={{ 'margin-left': '6px', 'font-size': '12px', color: 'var(--text-secondary)', 'line-height': '1.35', 'word-break': 'break-word' }}>{props.statusText}</span>}>
                <details style={{ 'margin-left': '6px' }}>
                  <summary style={{ cursor: 'pointer', 'font-size': '12px', color: 'var(--text-secondary)', 'line-height': '1.35', 'word-break': 'break-word' }}>{props.statusText}</summary>
                  <div style={{ 'margin-top': '6px', padding: '6px 8px', 'border-left': '1px solid var(--border-medium)', color: 'var(--text-muted)', 'font-size': '10px', 'line-height': '1.45' }}>
                    <For each={(props.intentHistory || []).slice(0, -1)}>{(intent) => <div>{intent}</div>}</For>
                  </div>
                </details>
              </Show>
            </Show>
          </div>
        </div>
      </Show>
    </div>
    <Show when={!pinned()}>
      <button
        onClick={scrollToBottom}
        title="Scroll to bottom"
        style={{
          position: 'absolute', bottom: '12px', right: '16px', 'z-index': '10',
          width: '32px', height: '32px', 'border-radius': '50%',
          background: 'var(--bg-surface)', color: 'var(--text-primary)',
          border: '1px solid var(--border-medium)', cursor: 'pointer',
          'font-size': '16px', display: 'flex', 'align-items': 'center', 'justify-content': 'center',
          'box-shadow': '0 2px 8px rgba(0,0,0,0.35)', opacity: '0.9',
        }}
      >
        <Show when={unreadCount() > 0}>
          <span style={{
            position: 'absolute', top: '-8px', right: '-8px',
            'min-width': '20px', height: '20px', padding: '0 5px',
            background: 'var(--accent)', color: 'var(--accent-text)',
            'font-size': '11px', 'font-weight': '600', 'border-radius': '10px',
            display: 'flex', 'align-items': 'center', 'justify-content': 'center', 'line-height': '1',
          }}>{unreadCount() > 99 ? '99+' : unreadCount()}</span>
        </Show>
        ↓
      </button>
    </Show>
    </div>
  )
}
