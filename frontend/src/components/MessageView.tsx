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
  Patch: '✂️', Input: '↵',
}

const TOOL_COLORS: Record<string, string> = {
  Bash: 'var(--tool-bash)', Read: 'var(--tool-read)', Write: 'var(--tool-write)', Edit: 'var(--tool-edit)',
  Grep: 'var(--tool-grep)', Glob: 'var(--tool-glob)', WebFetch: 'var(--tool-glob)', WebSearch: 'var(--tool-grep)',
  Agent: 'var(--tool-agent)', Skill: 'var(--tool-skill)',
  Patch: 'var(--tool-edit)', Input: 'var(--tool-read)',
}

// Normalize raw tool name (Anthropic 'Bash', MCP 'mcp__oc__bash', oc 'bash') to a
// canonical PascalCase key used for icon/color/summary/detail lookups.
const TOOL_ALIASES: Record<string, string> = {
  bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit',
  exec: 'Bash', exec_command: 'Bash', exec_comman: 'Bash',
  apply_patch: 'Patch', write_stdin: 'Input',
  grep: 'Grep', glob: 'Glob', find: 'Glob',
  task: 'Agent', agent: 'Agent',
  webfetch: 'WebFetch', fetch: 'WebFetch',
  websearch: 'WebSearch', web_search: 'WebSearch',
}

function canonicalName(raw: string): string {
  if (!raw) return 'tool'
  const stripped = raw.replace(/^mcp__.+?__/, '').split('.').pop() || raw
  return TOOL_ALIASES[stripped.toLowerCase()] || stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

function commandText(input: any): string {
  return ((input?.command || input?.cmd) as string || '').trim()
}

function patchText(input: any): string {
  return ((input?.raw || input?.input || input?.patch) as string || '').trim()
}

function stdinText(input: any): string {
  return ((input?.chars || input?.input) as string || '')
}

function patchSummary(input: any): string {
  const text = patchText(input)
  if (!text) return ''
  const firstFile = text.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1]
  const changeCount = (text.match(/^\*\*\* (?:Update|Add|Delete) File: /gm) || []).length
  if (firstFile) {
    const short = firstFile.split('/').slice(-2).join('/')
    return changeCount > 1 ? `${short} +${changeCount - 1}` : short
  }
  const firstLine = text.split('\n').find(Boolean) || ''
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine
}

function stdinSummary(input: any): string {
  const chars = stdinText(input)
  if (!chars) return input?.session_id != null ? `session ${input.session_id}` : ''
  const visible = chars
    .replace(/\u0003/g, '^C')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  const prefix = input?.session_id != null ? `session ${input.session_id}: ` : ''
  return prefix + (visible.length > 60 ? visible.slice(0, 60) + '…' : visible)
}

function toolSummary(name: string, input: any): string {
  if (!input) return ''
  const fp = ((input.file_path || input.path) as string) || ''
  const short = fp.split('/').slice(-2).join('/')
  switch (name) {
    case 'Read': return short + (input.offset ? ` L${input.offset}` : '')
    case 'Write': return short
    case 'Edit': return short + (input.replace_all ? ' ×all' : '')
    case 'Bash': { const c = commandText(input).split('\n')[0]; return c.length > 80 ? c.slice(0, 80) + '…' : c }
    case 'Patch': return patchSummary(input)
    case 'Input': return stdinSummary(input)
    case 'Grep': return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`
    case 'Glob': return input.pattern || ''
    case 'Agent': { const d = input.description || (input.prompt as string || '').split('\n')[0]; return d ? (d.length > 80 ? d.slice(0, 80) + '…' : d) : '' }
    case 'WebFetch': return input.url || ''
    case 'WebSearch': return input.query || ''
    default: return ''
  }
}

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
      {rawContent && <div style={{ padding: '6px 12px', 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", color: isErr ? 'var(--error)' : 'var(--text-secondary)', 'white-space': 'pre-wrap', 'max-height': '300px', overflow: 'auto', 'word-break': 'break-all' }} innerHTML={ansiToSafeHtml(rawContent.length > 3000 ? rawContent.slice(0, 3000) + '\n… (truncated)' : rawContent)} />}
    </div>
  )
}

function renderBlock(block: ContentBlock, setLightbox?: (v: string | null) => void, getResult?: (toolUseId: string) => ContentBlock | undefined) {
  if (block.type === 'text' && block.text) {
    return <div class="markdown" innerHTML={renderMarkdown(block.text)} ref={(el) => { injectCopyButtons(el); fixLinks(el) }} />
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
    const name = canonicalName(block.name || '')
    const color = TOOL_COLORS[name] || 'var(--info)'
    const icon = TOOL_ICONS[name] || '⚙'
    const summary = toolSummary(name, block.input)
    const inp = block.input || {}
    const result = block.id && getResult ? getResult(block.id) : undefined
    const hasDetail = name === 'Edit' || name === 'Bash' || name === 'Patch' || name === 'Input' || name === 'Write' || name === 'Agent' || name === 'Grep' || name === 'Read' || !!result
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
        {name === 'Bash' && commandText(inp) && <pre style={`${pre}color:var(--tool-bash);`}>{commandText(inp)}</pre>}
        {name === 'Patch' && patchText(inp) && <pre style={`${pre}color:var(--tool-edit);`}>{patchText(inp).slice(0, 2000)}{patchText(inp).length > 2000 ? '\n…' : ''}</pre>}
        {name === 'Input' && <pre style={`${pre}color:var(--tool-read);`}>{stdinText(inp).replace(/\u0003/g, '^C') || '(empty stdin)'}{inp.session_id != null ? `\n\nsession: ${inp.session_id}` : ''}</pre>}
        {name === 'Write' && inp.content && <pre style={`${pre}color:var(--diff-add-text);background:var(--diff-add-bg);`}>{(inp.content as string).slice(0, 500)}{(inp.content as string).length > 500 ? '…' : ''}</pre>}
        {name === 'Agent' && <>
          {inp.subagent_type && <div style={{ padding: '6px 12px', 'font-size': '11px', color: 'var(--text-secondary)' }}>Type: <span style={{ color: 'var(--warning)' }}>{inp.subagent_type}</span></div>}
          {inp.prompt && <pre style={`${pre}color:var(--tool-agent);`}>{(inp.prompt as string).slice(0, 800)}{(inp.prompt as string).length > 800 ? '…' : ''}</pre>}
        </>}
        {name === 'Grep' && inp.pattern && <pre style={`${pre}color:var(--tool-grep);`}>/{inp.pattern}/{inp.path ? ` in ${inp.path}` : ''}</pre>}
        {name === 'Read' && (inp.file_path || inp.path) && <pre style={`${pre}color:var(--tool-read);`}>{(inp.file_path || inp.path) as string}{inp.offset ? ` (L${inp.offset})` : ''}</pre>}
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
        {rawContent && <div style={{ padding: '8px 12px', 'font-size': '11px', 'font-family': "'SF Mono', Menlo, monospace", color: isErr ? 'var(--error)' : 'var(--text-secondary)', 'white-space': 'pre-wrap', 'max-height': '300px', overflow: 'auto', 'word-break': 'break-all' }} innerHTML={ansiToSafeHtml(rawContent.length > 3000 ? rawContent.slice(0, 3000) + '\n… (truncated)' : rawContent)} />}
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

// ── Consecutive tool-call grouping ──────────────────────────────────────────
// Mirrors pi-dashboard's groupConsecutiveToolCalls: runs of 3+ assistant messages
// whose only content is a tool_use with the SAME name + SAME JSON-stringified input
// collapse into a single expandable group (e.g. retry loops).
// Adjacent tool-only assistant messages (even with different args) are also wrapped
// into a single flat "tool chain" container so they read as one sequence instead of
// a stack of separate bubbles.

function isToolOnlyAssistantMsg(m: Message): boolean {
  if (m.role !== 'assistant' || !m.content || m.content.length === 0) return false
  let hasTool = false
  for (const b of m.content) {
    if (b.type === 'tool_use') {
      // AskUserQuestion is rendered as a special question bubble, not a tool step
      if ((b as any).name === 'AskUserQuestion') return false
      hasTool = true
    } else if (b.type === 'text' && (b as any).text?.trim()) {
      return false
    }
    // thinking blocks are collapsed details, allow them
    // tool_result blocks only appear on user-role messages
  }
  return hasTool
}

function toolSig(m: Message): { name: string; input: string } {
  const tu = (m.content || []).find(b => b.type === 'tool_use') as any
  return { name: tu?.name || '', input: JSON.stringify(tu?.input || {}) }
}

type RenderItem =
  | { kind: 'msg'; msg: Message }
  | { kind: 'chain'; messages: Message[] }

function buildRenderItems(messages: Message[], isPureToolResult: (m: Message) => boolean): RenderItem[] {
  const out: RenderItem[] = []
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (isPureToolResult(m)) { i++; continue }
    if (isToolOnlyAssistantMsg(m)) {
      const chain: Message[] = [m]
      let j = i + 1
      while (j < messages.length) {
        const n = messages[j]
        if (isPureToolResult(n)) { j++; continue }
        if (!isToolOnlyAssistantMsg(n)) break
        chain.push(n)
        j++
      }
      out.push({ kind: 'chain', messages: chain })
      i = j
    } else {
      out.push({ kind: 'msg', msg: m })
      i++
    }
  }
  return out
}

type ChainSegment =
  | { kind: 'single'; msg: Message }
  | { kind: 'group'; messages: Message[]; name: string; input: string }

function segmentChain(chain: Message[]): ChainSegment[] {
  const out: ChainSegment[] = []
  let i = 0
  while (i < chain.length) {
    const sig = toolSig(chain[i])
    let j = i + 1
    while (j < chain.length) {
      const s = toolSig(chain[j])
      if (s.name !== sig.name || s.input !== sig.input) break
      j++
    }
    const run = chain.slice(i, j)
    if (run.length >= 3) out.push({ kind: 'group', messages: run, name: sig.name, input: sig.input })
    else for (const m of run) out.push({ kind: 'single', msg: m })
    i = j
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
.markdown blockquote {
  margin: 6px 0; padding: 4px 12px; border-left: 3px solid var(--text-faint); color: var(--text-secondary);
}
.markdown table { border-collapse: collapse; margin: 8px 0; font-size: 0.9em; display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
.markdown th, .markdown td { border: 1px solid var(--border-medium); padding: 5px 10px; text-align: left; white-space: nowrap; }
.markdown th { background: rgba(255,255,255,0.05); font-weight: 600; }
.markdown a { color: var(--link); text-decoration: none; }
.markdown a:hover { text-decoration: underline; }
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

function fileUrl(absPath: string): string {
  return `${location.pathname.replace(/\/+$/, '')}/api/file?path=${encodeURIComponent(absPath)}`
}

export function MessageView(props: { messages: Message[], loading: boolean, hasMore?: boolean, loadingMore?: boolean, onLoadEarlier?: () => void, onAnswer?: (text: string) => void, starred?: Set<string>, onToggleStar?: (uuid: string) => void, onViewRaw?: (msg: Message) => void, working?: boolean, activeTool?: string | null }) {
  const [lightbox, setLightbox] = createSignal<string | null>(null)
  const [pdfViewer, setPdfViewer] = createSignal<string | null>(null)

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

  // A message whose visible content is only tool_result gets folded into the tool_use above — skip it.
  function isPureToolResultMsg(m: Message): boolean {
    if (!m.content || m.content.length === 0) return false
    return m.content.every(b =>
      b.type === 'tool_result' ||
      (b.type === 'text' && !b.text?.trim())
    ) && m.content.some(b => b.type === 'tool_result')
  }

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

  createEffect(() => {
    const len = props.messages.length // track
    const delta = len - prevMsgLen
    prevMsgLen = len
    if (pinned()) {
      requestAnimationFrame(() => scrollRef?.scrollTo({ top: scrollRef!.scrollHeight }))
    } else if (delta > 0) {
      setUnreadCount(c => c + delta)
    }
  })

  return (
    <div style={{ position: 'relative', height: '100%' }}>
    <div ref={scrollRef} onScroll={onScroll} onClick={handleCopyClick} style={{ height: '100%', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', 'overscroll-behavior': 'contain', padding: '16px', 'padding-bottom': '80px' }}>
      <style>{markdownCSS}</style>
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

      <For each={buildRenderItems(props.messages, isPureToolResultMsg)}>{(item) => {
        if (item.kind === 'chain') {
          // Flat tool-chain: one compact container wrapping consecutive tool-only
          // assistant messages. Runs of 3+ identical calls collapse into a group.
          const segments = segmentChain(item.messages)
          return (
            <div class="msg-row" style={{ display: 'flex', 'justify-content': 'flex-start', 'margin-bottom': '12px' }}>
              <div style={{
                'max-width': '78%', padding: '6px 12px',
                'border-radius': '12px', background: '#1e1e1e',
                border: '1px solid rgba(255,255,255,0.06)',
                color: 'var(--text-primary)', overflow: 'hidden',
                'font-size': '14px', 'line-height': '1.45', 'word-break': 'break-word',
                display: 'flex', 'flex-direction': 'column', gap: '2px',
              }}>
                <For each={segments}>{(seg) => {
                  if (seg.kind === 'group') {
                    const [expanded, setExpanded] = createSignal(false)
                    const firstInput = (seg.messages[0].content || []).find(b => b.type === 'tool_use') as any
                    const segName = canonicalName(seg.name || '')
                    const sumText = toolSummary(segName, firstInput?.input) || segName
                    const color = TOOL_COLORS[segName] || 'var(--info)'
                    const icon = TOOL_ICONS[segName] || '⚙'
                    return (
                      <div style={{ 'border-left': '2px solid var(--border-medium)', 'padding-left': '10px', margin: '2px 0' }}>
                        <button onClick={() => setExpanded(!expanded())}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', 'font-size': '12px', display: 'flex', 'align-items': 'center', gap: '6px', padding: '2px 0', width: '100%', 'text-align': 'left' }}>
                          <span style={{ color: 'var(--text-muted)', 'font-size': '11px' }}>↻</span>
                          <span style={{ color, 'font-family': "'SF Mono', Menlo, monospace", 'font-size': '11px', 'flex-shrink': '0' }}>{icon} {segName}</span>
                          <span style={{ color: 'var(--text-secondary)', 'font-family': "'SF Mono', Menlo, monospace", 'font-size': '11px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'min-width': '0' }}>{sumText}</span>
                          <span style={{ 'margin-left': 'auto', background: 'var(--bg-secondary)', color: 'var(--text-muted)', 'font-size': '10px', padding: '1px 7px', 'border-radius': '10px', 'font-weight': '600', 'flex-shrink': '0' }}>×{seg.messages.length}</span>
                          <span style={{ color: 'var(--text-ghost)', 'font-size': '10px', 'flex-shrink': '0' }}>{expanded() ? '▾' : '▸'}</span>
                        </button>
                        <Show when={expanded()}>
                          <div style={{ 'margin-top': '4px' }}>
                            <For each={seg.messages}>{(m) => (
                              <For each={m.content}>{(block) => renderBlock(block, setLightbox, getResult)}</For>
                            )}</For>
                          </div>
                        </Show>
                      </div>
                    )
                  }
                  // single tool-only message — render its blocks flat, no per-message bubble
                  const m = seg.msg
                  return (
                    <For each={m.content}>{(block) => renderBlock(block, setLightbox, getResult)}</For>
                  )
                }}</For>
                {/* one metadata row at the bottom, using last message's timestamp */}
                {(() => {
                  const last = item.messages[item.messages.length - 1]
                  return (
                    <div class="msg-meta" style={{
                      display: 'flex', 'align-items': 'center', 'justify-content': 'space-between',
                      gap: '8px', 'margin-top': '6px', 'padding-top': '4px',
                      'border-top': '1px solid rgba(255,255,255,0.06)',
                      'font-size': '11px', color: 'var(--text-faint)',
                    }}>
                      <span>{formatTime(last.timestamp)}</span>
                      <span style={{ color: 'var(--text-ghost)', 'font-size': '10px' }}>{item.messages.length} tool call{item.messages.length === 1 ? '' : 's'}</span>
                    </div>
                  )
                })()}
              </div>
            </div>
          )
        }

        const msg = item.msg
        // Extract images from text blocks
        const textBlock = msg.content?.find(b => b.type === 'text' && b.text)
        const { cleanText, images, files } = textBlock?.text ? extractImages(textBlock.text) : { cleanText: textBlock?.text || '', images: [], files: [] }
        const hasAttachments = images.length > 0 || files.length > 0

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
                  <img src={src} onClick={() => setLightbox(src)} style={{ 'max-width': '100%', 'max-height': '300px', 'border-radius': '6px', 'margin-bottom': '4px', cursor: 'zoom-in', display: 'block' }} />
                )}</For>
                <For each={files}>{(f) => {
                  const isPdf = f.name.toLowerCase().endsWith('.pdf')
                  const url = fileUrl(f.path)
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
                  return display ? <div class="markdown" innerHTML={renderMarkdown(display)} ref={(el) => { injectCopyButtons(el); fixLinks(el) }} /> : null
                })()}
                {metadataRow}
              </div>
            </div>
          )
        }

        // Assistant message: single wide bubble containing all blocks (text, tool_use, thinking) + metadata inside.
        return (
          <div class="msg-row" style={{ display: 'flex', 'justify-content': 'flex-start', 'margin-bottom': '12px' }}>
            <div style={{
              'max-width': '78%', padding: '10px 14px 8px',
              'border-radius': '12px',
              background: '#1e1e1e',
              border: '1px solid rgba(255,255,255,0.06)',
              color: 'var(--text-primary)', overflow: 'hidden',
              'font-size': '14px', 'line-height': '1.55', 'word-break': 'break-word',
            }}>
              <For each={msg.content}>{(block) => {
                if (block.type === 'text' && block.text) {
                  const { cleanText: bText, images: bImgs, files: bFiles } = extractImages(block.text)
                  const hasAny = bImgs.length > 0 || bFiles.length > 0 || bText.trim().length > 0
                  if (!hasAny) return null
                  return (
                    <div>
                      <For each={bImgs}>{(src) => (
                        <img src={src} onClick={() => setLightbox(src)} style={{ 'max-width': '100%', 'max-height': '300px', 'border-radius': '8px', 'margin-bottom': '4px', cursor: 'zoom-in', display: 'block' }} />
                      )}</For>
                      <For each={bFiles}>{(f) => {
                        const isPdf = f.name.toLowerCase().endsWith('.pdf')
                        const url = fileUrl(f.path)
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
                        <div class="markdown" innerHTML={renderMarkdown(bText)} ref={(el) => { injectCopyButtons(el); fixLinks(el) }} />
                      )}
                    </div>
                  )
                }
                if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                  const q = block.input?.question || 'Claude is asking a question...'
                  return (
                    <div style={{ 'margin': '6px 0', background: 'rgba(168, 85, 247, 0.06)', border: '1px solid rgba(168, 85, 247, 0.25)', 'border-left': '2px solid #a855f7', 'border-radius': '10px', padding: '12px' }}>
                      <div style={{ color: '#a855f7', 'font-size': '10px', 'font-weight': '700', 'text-transform': 'uppercase', 'letter-spacing': '0.08em', 'margin-bottom': '6px' }}>Question</div>
                      <div style={{ color: 'var(--text-primary)', 'font-size': '14px', 'margin-bottom': '10px' }}>{q}</div>
                      <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
                        <For each={['Yes', 'No', 'Continue']}>{(label) => (
                          <button onClick={() => props.onAnswer?.(label)}
                            style={{ background: 'var(--border-medium)', border: '1px solid var(--text-dim)', color: 'var(--text-primary)', padding: '4px 12px', 'border-radius': '6px', 'font-size': '12px', cursor: 'pointer' }}>{label}</button>
                        )}</For>
                      </div>
                    </div>
                  )
                }
                // thinking, tool_use, tool_result — flat rendering via renderBlock (inside bubble)
                return renderBlock(block, setLightbox, getResult)
              }}</For>
              {metadataRow}
            </div>
          </div>
        )
      }}</For>

      {/* Typing indicator */}
      <Show when={props.working}>
        <div style={{ display: 'flex', 'align-items': 'flex-start', 'margin-bottom': '10px' }}>
          <div style={{ padding: '10px 16px', 'border-radius': '16px 16px 16px 4px', background: 'var(--bg-surface)', display: 'flex', gap: '6px', 'align-items': 'center' }}>
            <span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: 'var(--text-secondary)', 'animation': 'typing-bounce 1.2s ease-in-out infinite' }} />
            <span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: 'var(--text-secondary)', 'animation': 'typing-bounce 1.2s ease-in-out 0.2s infinite' }} />
            <span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: 'var(--text-secondary)', 'animation': 'typing-bounce 1.2s ease-in-out 0.4s infinite' }} />
            <Show when={props.activeTool}>
              <span style={{ 'margin-left': '6px', 'font-size': '11px', color: 'var(--info)', 'font-family': "'SF Mono', Menlo, monospace" }}>{props.activeTool}</span>
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
