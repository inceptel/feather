import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { fetchUsage, UsageSnapshot, UsageWindow, UsageGroup, LimitWindow } from '../api'

// Costs: one place to see how close each provider is to its limit and where
// the tokens went (model, Room, session) for the last 5 hours, day, and week.

const ink = '#e6ebf2'
const body = '#c9d1dc'
const muted = '#8b97a8'
const line = '#1e2632'
const green = '#69c77f'
const amber = '#e0b45f'
const red = '#e3826d'
const panel = '#0f141b'

function tokens(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`
  return String(Math.round(n))
}

function money(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`
}

function timeAgo(iso: string | null | undefined) {
  if (!iso) return ''
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function timeUntil(iso: string | null | undefined) {
  if (!iso) return ''
  const m = Math.ceil((new Date(iso).getTime() - Date.now()) / 60000)
  if (m <= 0) return 'resets now'
  if (m < 60) return `resets in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `resets in ${h}h ${m % 60}m`
  return `resets in ${Math.floor(h / 24)}d`
}

function windowName(name: string) {
  return name.replace(/_/g, ' ').replace(/^five hour$/, '5 hour').replace(/^seven day$/, '7 day')
}

function barColor(fraction: number) {
  if (fraction >= 0.9) return red
  if (fraction >= 0.7) return amber
  return green
}

function total(g: { input: number, output: number, cacheRead: number, cacheWrite: number }) {
  return g.input + g.output + g.cacheRead + g.cacheWrite
}

const cardStyle = { background: panel, border: `1px solid ${line}`, 'border-radius': '12px', padding: '14px 16px', 'min-width': '0' }
const labelStyle = { color: muted, 'font-size': '11px', 'font-weight': '650', 'letter-spacing': '0.06em', 'text-transform': 'uppercase' as const }
const cellNum = { 'text-align': 'right' as const, 'font-variant-numeric': 'tabular-nums', 'white-space': 'nowrap' as const, padding: '6px 8px', color: body }

function Bar(props: { window: LimitWindow }) {
  const fraction = () => {
    const u = props.window.utilization
    return Math.max(0, Math.min(1, u > 1.5 ? u / 100 : u))
  }
  return (
    <div style={{ display: 'grid', 'grid-template-columns': '84px 1fr 52px', gap: '10px', 'align-items': 'center', margin: '6px 0' }}>
      <span style={{ color: body, 'font-size': '13px', 'text-transform': 'capitalize' }}>{windowName(props.window.name)}</span>
      <div title={timeUntil(props.window.resetsAt)} style={{ height: '8px', background: '#1a212c', 'border-radius': '4px', overflow: 'hidden' }}>
        <div style={{ width: `${Math.round(fraction() * 100)}%`, height: '100%', background: barColor(fraction()), transition: 'width 240ms' }} />
      </div>
      <span style={{ color: ink, 'font-size': '13px', 'font-variant-numeric': 'tabular-nums', 'text-align': 'right' }}>{Math.round(fraction() * 100)}%</span>
      <Show when={props.window.resetsAt}>
        <span style={{ 'grid-column': '2 / span 2', color: muted, 'font-size': '11px', 'margin-top': '-4px' }}>{timeUntil(props.window.resetsAt)}</span>
      </Show>
    </div>
  )
}

function Note(props: { text: string | null | undefined, tone?: 'warn' | 'muted' }) {
  return (
    <Show when={props.text}>
      <div style={{ color: props.tone === 'warn' ? amber : muted, 'font-size': '12px', 'line-height': '1.4', 'margin-top': '8px' }}>{props.text}</div>
    </Show>
  )
}

function Table(props: { title: string, rows: UsageGroup[], first: (g: UsageGroup) => any, firstLabel: string, onRow?: (g: UsageGroup) => void, showCost: boolean }) {
  return (
    <div style={cardStyle}>
      <div style={{ ...labelStyle, 'margin-bottom': '8px' }}>{props.title}</div>
      <Show when={props.rows.length > 0} fallback={<div style={{ color: muted, 'font-size': '13px' }}>Nothing in this window.</div>}>
        <div style={{ 'overflow-x': 'auto' }}>
          <table style={{ 'border-collapse': 'collapse', width: '100%', 'font-size': '13px' }}>
            <thead>
              <tr style={{ color: muted, 'font-size': '11px' }}>
                <th style={{ 'text-align': 'left', padding: '4px 8px', 'font-weight': '600' }}>{props.firstLabel}</th>
                <th style={{ ...cellNum, 'font-weight': '600' }}>Reqs</th>
                <th style={{ ...cellNum, 'font-weight': '600' }}>In</th>
                <th style={{ ...cellNum, 'font-weight': '600' }}>Cache</th>
                <th style={{ ...cellNum, 'font-weight': '600' }}>Out</th>
                <Show when={props.showCost}><th style={{ ...cellNum, 'font-weight': '600' }}>Cost</th></Show>
              </tr>
            </thead>
            <tbody>
              <For each={props.rows}>{(g) => (
                <tr onClick={() => props.onRow?.(g)} style={{ 'border-top': `1px solid ${line}`, cursor: props.onRow ? 'pointer' : 'default' }}>
                  <td style={{ padding: '6px 8px', color: ink, 'min-width': '120px', 'word-break': 'break-word', 'line-height': '1.3' }}>{props.first(g)}</td>
                  <td style={cellNum}>{g.requests}</td>
                  <td style={cellNum}>{tokens(g.input + g.cacheWrite)}</td>
                  <td style={cellNum}>{tokens(g.cacheRead)}</td>
                  <td style={cellNum}>{tokens(g.output)}</td>
                  <Show when={props.showCost}><td style={cellNum}>{g.costedRequests > 0 ? money(g.cost) : '—'}</td></Show>
                </tr>
              )}</For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  )
}

export function CostsView(props: { onOpenSession: (id: string) => void }) {
  const [data, setData] = createSignal<UsageSnapshot | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [windowKey, setWindowKey] = createSignal<'5h' | '24h' | '7d'>('5h')
  let timer: ReturnType<typeof setInterval> | undefined

  async function load(refresh = false) {
    setLoading(true)
    try {
      setData(await fetchUsage(refresh))
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'Could not load usage')
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    load()
    timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, 120_000)
  })
  onCleanup(() => { if (timer) clearInterval(timer) })

  const current = (): UsageWindow | undefined => data()?.windows.find(w => w.key === windowKey())
  const showCost = () => (current()?.totals.costedRequests || 0) > 0
  const anthropic = () => data()?.providers.anthropic
  const openrouter = () => data()?.providers.openrouter
  const codex = () => data()?.providers.codex
  const orFraction = () => {
    const o = openrouter()
    if (!o || !o.totalCredits) return 0
    return Math.max(0, Math.min(1, (o.totalUsage || 0) / o.totalCredits))
  }

  const pill = (active: boolean) => ({
    background: active ? '#1b2430' : 'transparent', color: active ? ink : muted, border: `1px solid ${active ? '#2b3644' : line}`,
    'border-radius': '999px', padding: '5px 12px', 'font-size': '12px', 'font-weight': '650', cursor: 'pointer',
  })

  return (
    <div data-testid="costs-view" style={{ height: '100%', 'overflow-y': 'auto', '-webkit-overflow-scrolling': 'touch', background: '#0b0f14', color: body }}>
      <div style={{ 'max-width': '1040px', margin: '0 auto', padding: '20px 16px 60px' }}>
        <div style={{ display: 'flex', 'align-items': 'baseline', gap: '12px', 'flex-wrap': 'wrap', 'margin-bottom': '16px' }}>
          <h1 style={{ margin: '0', color: ink, 'font-size': '22px', 'font-weight': '700' }}>Costs</h1>
          <span style={{ color: muted, 'font-size': '13px' }}>Where the tokens went, and how much room is left on each account.</span>
          <button data-testid="costs-refresh" onClick={() => load(true)} disabled={loading()}
            style={{ ...pill(false), 'margin-left': 'auto', opacity: loading() ? 0.6 : 1 }}>{loading() ? 'Refreshing…' : 'Refresh'}</button>
        </div>

        <Show when={error()}>
          <div style={{ ...cardStyle, color: red, 'margin-bottom': '16px' }}>{error()}</div>
        </Show>

        <Show when={data()}>
          <div style={{ ...labelStyle, 'margin-bottom': '8px' }}>Account limits</div>
          <div style={{ display: 'grid', 'grid-template-columns': 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px', 'margin-bottom': '24px' }}>
            <div style={cardStyle} data-testid="limits-anthropic">
              <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'baseline' }}>
                <span style={{ color: ink, 'font-size': '15px', 'font-weight': '650' }}>Anthropic</span>
                <span style={{ color: muted, 'font-size': '11px' }}>{anthropic()?.lastGoodAt ? `read ${timeAgo(anthropic()!.lastGoodAt)}` : 'no reading yet'}</span>
              </div>
              <div style={{ color: muted, 'font-size': '12px', margin: '2px 0 8px' }}>Claude subscription. Claude Code and OMP share these windows.</div>
              <Show when={(anthropic()?.windows || []).length > 0} fallback={<div style={{ color: muted, 'font-size': '13px' }}>Limits not available yet.</div>}>
                <For each={anthropic()!.windows}>{(w) => <Bar window={w} />}</For>
              </Show>
              <Note text={anthropic()?.error} tone="warn" />
            </div>

            <div style={cardStyle} data-testid="limits-openrouter">
              <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'baseline' }}>
                <span style={{ color: ink, 'font-size': '15px', 'font-weight': '650' }}>OpenRouter</span>
                <span style={{ color: muted, 'font-size': '11px' }}>{openrouter()?.lastGoodAt ? `read ${timeAgo(openrouter()!.lastGoodAt)}` : 'no reading yet'}</span>
              </div>
              <div style={{ color: muted, 'font-size': '12px', margin: '2px 0 8px' }}>Prepaid credits. Gemini images and any OpenRouter model draw from here.</div>
              <Show when={openrouter()?.totalCredits !== undefined} fallback={<div style={{ color: muted, 'font-size': '13px' }}>Credits not available yet.</div>}>
                <div style={{ display: 'grid', 'grid-template-columns': '84px 1fr 52px', gap: '10px', 'align-items': 'center', margin: '6px 0' }}>
                  <span style={{ color: body, 'font-size': '13px' }}>Credits</span>
                  <div style={{ height: '8px', background: '#1a212c', 'border-radius': '4px', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.round(orFraction() * 100)}%`, height: '100%', background: barColor(orFraction()) }} />
                  </div>
                  <span style={{ color: ink, 'font-size': '13px', 'text-align': 'right', 'font-variant-numeric': 'tabular-nums' }}>{Math.round(orFraction() * 100)}%</span>
                </div>
                <div style={{ color: body, 'font-size': '13px', 'margin-top': '6px' }}>
                  <b style={{ color: ink }}>{money(openrouter()!.remaining)}</b> left of {money(openrouter()!.totalCredits)}
                </div>
                <div style={{ color: muted, 'font-size': '12px', 'margin-top': '4px' }}>
                  Today {money(openrouter()!.usageDaily)} · this week {money(openrouter()!.usageWeekly)} · this month {money(openrouter()!.usageMonthly)}
                </div>
              </Show>
              <Note text={openrouter()?.error} tone="warn" />
            </div>

            <div style={cardStyle} data-testid="limits-codex">
              <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'baseline' }}>
                <span style={{ color: ink, 'font-size': '15px', 'font-weight': '650' }}>OpenAI Codex</span>
                <span style={{ color: muted, 'font-size': '11px' }}>{codex()?.observedAt ? `seen ${timeAgo(codex()!.observedAt)}` : 'no reading yet'}</span>
              </div>
              <div style={{ color: muted, 'font-size': '12px', margin: '2px 0 8px' }}>ChatGPT subscription, as reported by the last Codex turn on this box.</div>
              <Show when={(codex()?.windows || []).length > 0} fallback={<div style={{ color: muted, 'font-size': '13px' }}>Limits not available yet.</div>}>
                <For each={codex()!.windows}>{(w) => <Bar window={w} />}</For>
              </Show>
              <Note text={codex()?.error} tone="warn" />
            </div>
          </div>

          <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap', 'margin-bottom': '10px' }}>
            <span style={labelStyle}>Usage</span>
            <div style={{ display: 'flex', gap: '6px', 'margin-left': '8px' }}>
              <For each={data()!.windows}>{(w) => (
                <button data-testid={`costs-window-${w.key}`} onClick={() => setWindowKey(w.key)} style={pill(windowKey() === w.key)}>{w.label.replace('Last ', '')}</button>
              )}</For>
            </div>
            <span style={{ color: muted, 'font-size': '11px', 'margin-left': 'auto' }}>
              {data()!.files} transcripts · scanned {timeAgo(data()!.generatedAt)}
            </span>
          </div>

          <Show when={current()}>{(w) => (
            <>
              <div style={{ display: 'grid', 'grid-template-columns': 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', 'margin-bottom': '12px' }}>
                <div style={cardStyle}><div style={labelStyle}>Requests</div><div style={{ color: ink, 'font-size': '22px', 'font-weight': '700' }}>{w().totals.requests}</div></div>
                <div style={cardStyle}><div style={labelStyle}>Input</div><div style={{ color: ink, 'font-size': '22px', 'font-weight': '700' }}>{tokens(w().totals.input + w().totals.cacheWrite)}</div><div style={{ color: muted, 'font-size': '11px' }}>{tokens(w().totals.cacheWrite)} written to cache</div></div>
                <div style={cardStyle}><div style={labelStyle}>Cache reads</div><div style={{ color: ink, 'font-size': '22px', 'font-weight': '700' }}>{tokens(w().totals.cacheRead)}</div><div style={{ color: muted, 'font-size': '11px' }}>cheap re-reads of context</div></div>
                <div style={cardStyle}><div style={labelStyle}>Output</div><div style={{ color: ink, 'font-size': '22px', 'font-weight': '700' }}>{tokens(w().totals.output)}</div></div>
                <Show when={showCost()}>
                  <div style={cardStyle}><div style={labelStyle}>Metered cost</div><div style={{ color: ink, 'font-size': '22px', 'font-weight': '700' }}>{money(w().totals.cost)}</div><div style={{ color: muted, 'font-size': '11px' }}>{w().totals.costedRequests} of {w().totals.requests} requests priced by the harness</div></div>
                </Show>
              </div>
              <div style={{ color: muted, 'font-size': '12px', margin: '0 0 14px', 'line-height': '1.45' }}>
                Cost is the harness's list-price estimate for requests it priced; Claude Code turns are not priced. Claude and Codex are flat-rate subscriptions, so their real limit is the account windows above, not the dollar figure.
              </div>
              <div style={{ display: 'grid', 'grid-template-columns': 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px' }}>
                <Table title="By model" rows={w().byModel} firstLabel="Model" showCost={showCost()}
                  first={(g) => <span>{g.model}<span style={{ color: muted }}> · {g.harness}</span></span>} />
                <Table title="By Room" rows={w().byRoom} firstLabel="Room" showCost={showCost()}
                  first={(g) => g.room ? `#${g.room}` : <span style={{ color: muted }}>outside Rooms</span>} />
              </div>
              <div style={{ 'margin-top': '12px' }}>
                <Table title="Top sessions" rows={w().bySession} firstLabel="Session" showCost={showCost()}
                  onRow={(g) => { if (g.sessionId && g.harness !== 'codex') props.onOpenSession(g.sessionId) }}
                  first={(g) => <span>{g.room ? `#${g.room} · ` : ''}{g.model}<span style={{ color: muted }}> · {g.harness} · {(g.sessionId || '').slice(0, 8)}</span></span>} />
              </div>
            </>
          )}</Show>
        </Show>
      </div>
    </div>
  )
}
