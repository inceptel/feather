import { createSignal, createEffect, onCleanup, Show } from 'solid-js'

interface Props {
  active: boolean
}

export default function CaptainLog(props: Props) {
  const [html, setHtml] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const [lastModified, setLastModified] = createSignal('')
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let iframe: HTMLIFrameElement | undefined

  async function fetchContent() {
    try {
      setLoading(true)
      setError('')
      const res = await fetch('/api/captainlog/content')
      if (!res.ok) throw new Error(await res.text())
      const content = await res.text()
      setHtml(content)
    } catch (e: any) {
      setError(e.message || 'Failed to load CaptainLog')
    } finally {
      setLoading(false)
    }
  }

  async function checkModified() {
    try {
      const res = await fetch('/api/captainlog/meta')
      if (!res.ok) return
      const meta = await res.json()
      const mod = meta.lastModifiedDateTime || ''
      if (mod && mod !== lastModified()) {
        setLastModified(mod)
        fetchContent()
      }
    } catch {}
  }

  createEffect(() => {
    if (props.active) {
      fetchContent()
      // Poll for changes every 15s
      pollTimer = setInterval(checkModified, 15000)
    } else {
      if (pollTimer) clearInterval(pollTimer)
    }
  })

  onCleanup(() => { if (pollTimer) clearInterval(pollTimer) })

  // Write HTML into iframe for proper rendering
  createEffect(() => {
    if (iframe && html()) {
      const doc = iframe.contentDocument
      if (doc) {
        doc.open()
        doc.write(`
          <html>
          <head>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                background: #0d1117;
                color: #e5e5e5;
                padding: 16px;
                margin: 0;
                font-size: 14px;
                line-height: 1.5;
              }
              h1 { color: #7c3aed; font-size: 20px; }
              hr { border: none; border-top: 1px solid #333; margin: 12px 0; }
              div[style*="border-left"] {
                border-radius: 4px;
              }
              p { margin: 4px 0; }
              table { border-collapse: collapse; }
              td, th { padding: 4px 8px; border: 1px solid #444; }
              th { background: #1a1a2e; }
              a { color: #7c3aed; }
            </style>
          </head>
          <body>${html().replace(/<html[^>]*>[\s\S]*<body[^>]*>/i, '').replace(/<\/body>[\s\S]*<\/html>/i, '')}</body>
          </html>
        `)
        doc.close()
      }
    }
  })

  return (
    <div style={{ height: '100%', display: 'flex', 'flex-direction': 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', padding: '8px 16px', 'border-bottom': '1px solid #1e1e1e', 'flex-shrink': '0' }}>
        <span style={{ color: '#7c3aed', 'font-weight': '600', 'font-size': '13px' }}>CaptainLog</span>
        <span style={{ color: '#444', 'font-size': '11px' }}>OneNote</span>
        <Show when={lastModified()}>
          <span style={{ color: '#555', 'font-size': '10px', 'margin-left': 'auto' }}>
            Modified: {new Date(lastModified()).toLocaleString()}
          </span>
        </Show>
        <button
          onClick={() => fetchContent()}
          style={{ 'margin-left': lastModified() ? '8px' : 'auto', background: 'none', border: '1px solid #333', color: '#888', padding: '2px 8px', 'border-radius': '4px', cursor: 'pointer', 'font-size': '11px' }}
        >
          Refresh
        </button>
      </div>

      {/* Content */}
      <Show when={!error()} fallback={
        <div style={{ padding: '40px', 'text-align': 'center', color: '#d45555' }}>
          <div style={{ 'font-size': '14px', 'margin-bottom': '8px' }}>Failed to load CaptainLog</div>
          <div style={{ 'font-size': '12px', color: '#888' }}>{error()}</div>
        </div>
      }>
        <Show when={!loading() || html()} fallback={
          <div style={{ padding: '40px', 'text-align': 'center', color: '#555' }}>Loading CaptainLog...</div>
        }>
          <iframe
            ref={iframe}
            style={{ flex: '1', border: 'none', width: '100%', background: '#0d1117' }}
            sandbox="allow-same-origin"
          />
        </Show>
      </Show>
    </div>
  )
}
