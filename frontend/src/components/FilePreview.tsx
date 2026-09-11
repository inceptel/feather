import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import { renderMarkdown, markdownCSS } from './MessageView'
import { localFileUrl } from '../lib/localMedia.js'
import { linkTarget, addHeadingIds } from '../lib/linkTarget.js'
import './FilePreview.css'

export function FilePreview(props: { path: string, line?: number, onClose: () => void, onOpen: (path: string) => void }) {
  const [content, setContent] = createSignal('')
  const [state, setState] = createSignal<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = createSignal('')
  const [source, setSource] = createSignal(false)
  const [wrap, setWrap] = createSignal(false)
  const [retry, setRetry] = createSignal(0)
  let dialog!: HTMLDivElement
  const previousFocus = document.activeElement as HTMLElement | null
  const ext = () => props.path.split('.').pop()?.toLowerCase() || ''
  const kind = () => /^(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/.test(ext()) ? 'image' : ext() === 'pdf' ? 'pdf' : /^(md|markdown)$/.test(ext()) ? 'md' : /^(html?|xhtml)$/.test(ext()) ? 'html' : /^(mp4|webm|mov)$/.test(ext()) ? 'video' : /^(mp3|wav|ogg|m4a)$/.test(ext()) ? 'audio' : 'text'
  const url = () => localFileUrl(props.path)!
  const baseDir = () => props.path.slice(0, props.path.lastIndexOf('/'))
  const textKind = () => ['text', 'md', 'html'].includes(kind())
  createEffect(() => {
    props.path; retry()
    const controller = new AbortController()
    setContent(''); setError(''); setState('loading'); setSource(!!props.line)
    if (!textKind()) setState('ready')
    else void (async () => {
      try {
        const response = await fetch(url(), { signal: controller.signal })
        if (!response.ok) throw new Error(`Could not open this file (${response.status}).`)
        if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('This file is too large to preview. Download it instead.')
        const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0
        while (true) {
          const { value, done } = await reader.read(); if (done) break
          size += value.length
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('This file is too large to preview. Download it instead.') }
          chunks.push(value)
        }
        const bytes = new Uint8Array(size); let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        const text = new TextDecoder().decode(bytes)
        if (text.includes('\0')) throw new Error('This binary file cannot be previewed. Download it instead.')
        if (!controller.signal.aborted) { setContent(text); setState('ready') }
      } catch (e) { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : String(e)); setState('error') } }
    })()
    onCleanup(() => controller.abort())
  })
  onCleanup(() => previousFocus?.isConnected && previousFocus.focus())
  function keydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); props.onClose() }
    if (e.key !== 'Tab') return
    const nodes = Array.from(dialog.querySelectorAll<HTMLElement>('button, a[href], input')).filter(n => n.getClientRects().length)
    const first = nodes[0], last = nodes.at(-1)
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
  }
  const preview = createMemo(() => {
    if (!['md', 'html'].includes(kind())) return ''
    const html = kind() === 'md' ? renderMarkdown(content()) : DOMPurify.sanitize(content(), { WHOLE_DOCUMENT: true, ADD_TAGS: ['style'], FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'base', 'link', 'meta'] })
    const doc = new DOMParser().parseFromString(html, 'text/html')
    addHeadingIds(doc)
    for (const img of doc.querySelectorAll('img')) {
      const target = linkTarget(img.getAttribute('src'), baseDir())
      img.removeAttribute('srcset')
      if (target.kind === 'file') img.src = localFileUrl(target.path)!
      else img.removeAttribute('src')
    }
    if (kind() === 'md') return doc.body.innerHTML
    const policy = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${location.origin} data:; base-uri 'none'; form-action 'none'`
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}">${doc.head.innerHTML}</head><body>${doc.body.innerHTML}</body></html>`
  })
  const code = createMemo(() => {
    const language = ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', sh: 'bash' } as Record<string, string>)[ext()] || ext()
    return content().length < 200000 && hljs.getLanguage(language) ? hljs.highlight(content(), { language }).value : content().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  })
  createEffect(() => {
    if (state() === 'ready' && props.line && (source() || kind() === 'text')) {
      queueMicrotask(() => { const body = dialog?.querySelector('.file-preview-body'); if (body) body.scrollTop = Math.max(0, (props.line! - 3) * 22.1) })
    }
  })
  function follow(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest('a'); if (!a) return
    const target = linkTarget(a.getAttribute('href'), baseDir())
    e.preventDefault()
    if (target.kind === 'file') props.onOpen(target.path + (target.line ? ':' + target.line : ''))
    else if (target.kind === 'web') window.open(target.href, '_blank', 'noopener,noreferrer')
    else if (target.kind === 'anchor') {
      const heading = Array.from(dialog.querySelectorAll('[id]')).find(el => el.id === target.hash)
      heading?.scrollIntoView({ block: 'start' })
    }
  }
  return <div class="file-preview-backdrop" onClick={e => { if (e.target === e.currentTarget) props.onClose() }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="File preview" class="file-preview" onKeyDown={keydown}>
      <style>{markdownCSS}</style>
      <header><div class="file-preview-name"><strong>{props.path.split('/').pop()}</strong><span title={props.path}>{props.path}</span></div>
        <a href={`${url()}&download=1`} download={props.path.split('/').pop()}>Download</a>
        <button ref={el => queueMicrotask(() => el.focus())} aria-label="Close file preview" onClick={props.onClose}>×</button>
      </header>
      <nav aria-label="Preview controls">
        <Show when={kind() === 'md' || kind() === 'html'}>
          <button aria-pressed={!source()} onClick={() => setSource(false)}>Preview</button>
          <button aria-pressed={source()} onClick={() => setSource(true)}>Source</button>
        </Show>
        <Show when={kind() === 'text' || source()}><button aria-pressed={wrap()} onClick={() => setWrap(!wrap())}>Wrap lines</button></Show>
        <Show when={kind() === 'html' && !source()}><span>Static preview · scripts disabled</span></Show>
        <Show when={props.line}><span>Line {props.line}</span></Show>
      </nav>
      <div class="file-preview-body">
        <Show when={state() === 'loading'}><p role="status">Loading file…</p></Show>
        <Show when={state() === 'error'}><p role="alert">{error()}</p><button onClick={() => setRetry(n => n + 1)}>Retry</button></Show>
        <Show when={state() === 'ready'}>
          <Show when={textKind() && !content()}><p>This file is empty.</p></Show>
          <Show when={kind() === 'image'}><img class="file-preview-image" src={url()} alt={props.path.split('/').pop()} onError={() => { setError('This image could not be loaded.'); setState('error') }} /></Show>
          <Show when={kind() === 'pdf'}><iframe title="PDF preview" sandbox="" src={url()} /></Show>
          <Show when={kind() === 'video'}><video controls src={url()} /></Show>
          <Show when={kind() === 'audio'}><audio controls src={url()} /></Show>
          <Show when={kind() === 'html' && !source() && content()}><iframe title="HTML preview" sandbox="" referrerpolicy="no-referrer" srcdoc={preview()} /></Show>
          <Show when={kind() === 'md' && !source() && content()}><article class="markdown file-markdown" onClick={follow} innerHTML={preview()} /></Show>
          <Show when={content() && (kind() === 'text' || source())}><pre classList={{ 'file-source-wrap': wrap() }}><code innerHTML={code()} /></pre></Show>
        </Show>
      </div>
    </div>
  </div>
}
