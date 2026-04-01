import { onMount, onCleanup, createEffect } from 'solid-js'
import { init, Terminal as GhosttyTerm, FitAddon } from 'ghostty-web'

const basePath = location.pathname.replace(/\/+$/, '')
const BASE_WS = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${basePath}/api/terminal`

let wasmReady: Promise<void> | null = null
function ensureInit() {
  if (!wasmReady) wasmReady = init()
  return wasmReady
}

export function Terminal(props: { sessionId: string | null, box?: string }) {
  let containerRef: HTMLDivElement | undefined
  let term: GhosttyTerm | null = null
  let fitAddon: FitAddon | null = null
  let ws: WebSocket | null = null

  async function connect(sessionId: string) {
    disconnect()
    try { await ensureInit() } catch { return }

    term = new GhosttyTerm({
      theme: { background: '#0a0e14', foreground: '#e5e5e5', cursor: '#4aba6a' },
      fontSize: 13,
      fontFamily: "'SF Mono', Menlo, 'Courier New', monospace",
      cursorBlink: true,
      scrollback: 5000,
    })
    fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    if (containerRef) {
      term.open(containerRef)
      fitAddon.fit()
    }

    const boxParam = props.box && props.box !== 'local' ? `&box=${props.box}` : ''
    ws = new WebSocket(`${BASE_WS}?session=${sessionId}${boxParam}`)
    ws.onmessage = (e) => term?.write(e.data)
    ws.onclose = () => term?.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n')

    ws.onopen = () => {
      if (fitAddon && ws) {
        const dims = fitAddon.proposeDimensions()
        if (dims) ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
      }
    }

    term.onData((data) => { try { ws?.send(data) } catch {} })
    term.onResize(({ cols, rows }) => {
      try { ws?.send(JSON.stringify({ type: 'resize', cols, rows })) } catch {}
    })
  }

  function disconnect() {
    ws?.close()
    ws = null
    term?.dispose()
    term = null
    fitAddon = null
  }

  createEffect(() => {
    const sid = props.sessionId
    if (sid) connect(sid)
    else disconnect()
  })

  onMount(() => {
    const onResize = () => { try { fitAddon?.fit() } catch {} }
    window.addEventListener('resize', onResize)
    onCleanup(() => { window.removeEventListener('resize', onResize); disconnect() })
  })

  return (
    <>
      <div ref={containerRef}
        onKeyDown={(e) => e.stopPropagation()}
        onKeyPress={(e) => e.stopPropagation()}
        onKeyUp={(e) => e.stopPropagation()}
        style={{
          height: '100%', width: '100%', background: '#0a0e14',
          padding: '4px',
      }} />
    </>
  )
}
