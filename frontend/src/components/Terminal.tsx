import { onMount, onCleanup, createEffect, createSignal, Show } from 'solid-js'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const BASE_WS = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminal`

export function Terminal(props: { sessionId: string | null }) {
  let containerRef: HTMLDivElement | undefined
  let term: XTerm | null = null
  let fitAddon: FitAddon | null = null
  let ws: WebSocket | null = null
  let reconnectTimer = 0
  let connectionKey = 0
  const [connectionState, setConnectionState] = createSignal<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected'>('idle')

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = 0
    }
  }

  function scheduleReconnect(sessionId: string, key: number) {
    clearReconnectTimer()
    setConnectionState('reconnecting')
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = 0
      if (props.sessionId === sessionId && key === connectionKey) connect(sessionId)
    }, 1000)
  }

  function connect(sessionId: string) {
    disconnect()
    const key = connectionKey
    setConnectionState('connecting')

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
    ws.onclose = (event) => {
      term?.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n')
      if (!event.wasClean && props.sessionId === sessionId && key === connectionKey) {
        scheduleReconnect(sessionId, key)
      }
      else setConnectionState('disconnected')
    }

    ws.onopen = () => {
      clearReconnectTimer()
      setConnectionState('connected')
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
    clearReconnectTimer()
    connectionKey += 1
    if (ws) ws.onclose = null
    ws?.close()
    ws = null
    term?.dispose()
    term = null
    fitAddon = null
    setConnectionState('idle')
  }

  function reconnectNow() {
    const sid = props.sessionId
    if (sid) connect(sid)
  }

  createEffect(() => {
    const sid = props.sessionId
    if (sid) connect(sid)
    else disconnect()
  })

  onMount(() => {
    const onResize = () => { try { fitAddon?.fit() } catch {} }
    const observer = typeof ResizeObserver === 'undefined' || !containerRef
      ? null
      : new ResizeObserver(onResize)
    window.addEventListener('resize', onResize)
    observer?.observe(containerRef)
    onCleanup(() => { window.removeEventListener('resize', onResize); disconnect() })
    onCleanup(() => observer?.disconnect())
  })

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', background: '#0a0e14' }}>
      <div ref={containerRef} aria-label="Terminal output" style={{
        height: '100%', width: '100%', background: '#0a0e14',
        padding: '4px',
      }} />
      <Show when={connectionState() === 'reconnecting' || connectionState() === 'disconnected'}>
        <div aria-live="polite" style={{
          position: 'absolute',
          top: '12px',
          right: '12px',
          display: 'flex',
          'align-items': 'center',
          gap: '8px',
          padding: '8px 10px',
          background: 'rgba(13, 17, 23, 0.92)',
          border: '1px solid #333',
          'border-radius': '10px',
          color: '#e5e5e5',
          'font-size': '12px',
        }}>
          <span>{connectionState() === 'reconnecting' ? 'Terminal reconnecting...' : 'Terminal disconnected'}</span>
          <button onClick={reconnectNow} style={{
            background: '#4aba6a',
            color: '#000',
            border: 'none',
            'border-radius': '8px',
            padding: '6px 12px',
            'font-size': '12px',
            'font-weight': '600',
            cursor: 'pointer',
            'min-width': '44px',
            'min-height': '44px',
          }}>Retry now</button>
        </div>
      </Show>
    </div>
  )
}
