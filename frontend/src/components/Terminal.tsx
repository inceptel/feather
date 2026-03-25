import { onMount, onCleanup, createEffect } from 'solid-js'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const BASE_WS = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/new-dev/api/terminal`

export function Terminal(props: { sessionId: string | null }) {
  let containerRef: HTMLDivElement | undefined
  let term: XTerm | null = null
  let fitAddon: FitAddon | null = null
  let ws: WebSocket | null = null

  function connect(sessionId: string) {
    disconnect()

    term = new XTerm({
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

    ws = new WebSocket(`${BASE_WS}?session=${sessionId}`)
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
    <div ref={containerRef} style={{
      height: '100%', width: '100%', background: '#0a0e14',
      padding: '4px',
    }} />
  )
}
