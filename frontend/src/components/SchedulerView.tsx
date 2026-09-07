import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { fetchScheduler, fetchSchedulerRuns, schedulerRuleAction, deleteSchedulerRule, SchedulerSnapshot, SchedulerRule, SchedulerRun } from '../api'

// Scheduler: every wake rule Feather owns, in one table. What fires, when,
// why it did not, and the last runs. Rules are written with `room schedule`.

const ink = '#e6ebf2'
const body = '#c9d1dc'
const muted = '#8b97a8'
const line = '#1e2632'
const green = '#69c77f'
const amber = '#e0b45f'
const red = '#e3826d'
const panel = '#0f141b'

const cardStyle = { background: panel, border: `1px solid ${line}`, 'border-radius': '12px', padding: '14px 16px', 'min-width': '0' }
const labelStyle = { color: muted, 'font-size': '11px', 'font-weight': '650', 'letter-spacing': '0.06em', 'text-transform': 'uppercase' as const }
const cell = { padding: '6px 8px', color: body, 'vertical-align': 'top' as const, 'line-height': '1.35' }
const buttonStyle = { background: '#182030', border: `1px solid ${line}`, color: ink, 'border-radius': '6px', padding: '3px 8px', 'font-size': '12px', cursor: 'pointer' }

function clock(iso: string | null | undefined) {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function relative(iso: string | null | undefined) {
  if (!iso) return ''
  const m = Math.round((new Date(iso).getTime() - Date.now()) / 60000)
  if (Math.abs(m) < 1) return 'now'
  const abs = Math.abs(m)
  const text = abs < 60 ? `${abs}m` : abs < 48 * 60 ? `${Math.floor(abs / 60)}h ${abs % 60}m` : `${Math.floor(abs / 1440)}d`
  return m < 0 ? `${text} ago` : `in ${text}`
}
function shortId(ruleId: string, room: string) {
  return ruleId.startsWith(`${room}/`) ? ruleId.slice(room.length + 1) : ruleId
}
function targetText(rule: SchedulerRule) {
  const t = rule.target
  if (t.kind === 'resident') return t.role
  if (t.kind === 'session') return `session ${t.sessionId.slice(0, 8)}`
  if (t.kind === 'new') return `new ${t.engine}${t.model ? ` ${t.model}` : ''}`
  return 'leader'
}
function cadenceText(rule: SchedulerRule) {
  const parts: string[] = []
  if (rule.every) parts.push(`every ${rule.every}`)
  if (rule.cron) parts.push(`cron ${rule.cron}`)
  if (rule.after) parts.push(`after ${shortId(rule.after, rule.room)}`)
  for (const c of rule.when || []) {
    if (c.type === 'idle') parts.push('when idle')
    else if (c.type === 'file-changed') parts.push(`when ${c.path} changed`)
    else if (c.type === 'file-matches') parts.push(`when ${c.path} matches`)
    else if (c.type === 'frontier-has') parts.push(`when FRONTIER ${c.section} has lines`)
  }
  return parts.join(', ')
}
function statusOf(rule: SchedulerRule): { text: string, color: string } {
  const rt = rule.runtime
  if (!rule.enabled) return { text: 'disabled', color: muted }
  if (rt.paused) return { text: rt.pausedReason || 'paused', color: amber }
  if (rt.running) return { text: `running ${relative(rt.running.startedAt)}`, color: green }
  if (rt.overdue) return { text: 'overdue', color: red }
  if (rt.consecutiveFailures > 0) return { text: `${rt.consecutiveFailures} failed`, color: amber }
  return { text: 'ok', color: body }
}
function outcomeColor(outcome: string | undefined) {
  if (outcome === 'done') return green
  if (outcome === 'failed' || outcome === 'timeout') return red
  if (outcome === 'killed') return amber
  return muted
}

export function SchedulerView(props: { onOpenSession: (id: string) => void, onOpenRoom: (name: string) => void }) {
  const [data, setData] = createSignal<SchedulerSnapshot | null>(null)
  const [runs, setRuns] = createSignal<SchedulerRun[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal<string | null>(null)
  let timer: ReturnType<typeof setInterval> | undefined

  async function load() {
    try {
      const [snapshot, recent] = await Promise.all([fetchScheduler(), fetchSchedulerRuns({ limit: 40 })])
      setData(snapshot)
      setRuns(recent)
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'scheduler unavailable')
    }
  }
  async function act(rule: SchedulerRule, action: 'fire' | 'pause' | 'resume' | 'delete') {
    if (action === 'delete' && !confirm(`Remove rule ${rule.id}?`)) return
    setBusy(rule.id)
    try {
      if (action === 'delete') await deleteSchedulerRule(rule.id)
      else await schedulerRuleAction(rule.id, action)
      await load()
    } catch (e: any) {
      setError(e?.message || `${action} failed`)
    } finally {
      setBusy(null)
    }
  }
  onMount(() => { load(); timer = setInterval(load, 15000) })
  onCleanup(() => { if (timer) clearInterval(timer) })

  return (
    <div data-testid="scheduler-view" style={{ height: '100%', 'overflow-y': 'auto', padding: '16px', color: ink, 'font-family': 'system-ui, sans-serif' }}>
      <div style={{ 'max-width': '1100px', margin: '0 auto', display: 'flex', 'flex-direction': 'column', gap: '14px' }}>
        <div style={{ display: 'flex', 'align-items': 'baseline', gap: '12px', 'flex-wrap': 'wrap' }}>
          <h2 style={{ margin: '0', 'font-size': '18px', 'font-weight': '650' }}>Scheduler</h2>
          <Show when={data()}>{(d) => (
            <span style={{ color: muted, 'font-size': '12px' }}>
              {d().enabled ? `ticks every ${Math.round(d().tickMs / 1000)}s` : 'OFF (FEATHER_SCHEDULER=off)'}
              {d().lastTickAt ? ` · last tick ${relative(d().lastTickAt)}` : ''}
              {` · up since ${clock(d().bootAt)}`}
            </span>
          )}</Show>
          <button onClick={load} style={{ ...buttonStyle, 'margin-left': 'auto' }}>Refresh</button>
        </div>
        <Show when={error()}><div style={{ color: red, 'font-size': '13px' }}>{error()}</div></Show>

        <div style={cardStyle}>
          <div style={{ ...labelStyle, 'margin-bottom': '8px' }}>Rules</div>
          <Show when={(data()?.rules.length || 0) > 0} fallback={
            <div style={{ color: muted, 'font-size': '13px', 'line-height': '1.5' }}>
              No rules yet. From a Room directory: <code>room schedule set leader --target leader --fresh --every 1h</code>
            </div>
          }>
            <div style={{ 'overflow-x': 'auto' }}>
              <table data-testid="scheduler-rules" style={{ 'border-collapse': 'collapse', width: '100%', 'font-size': '13px' }}>
                <thead>
                  <tr style={{ color: muted, 'font-size': '11px' }}>
                    <th style={{ ...cell, 'text-align': 'left', 'font-weight': '600' }}>Rule</th>
                    <th style={{ ...cell, 'text-align': 'left', 'font-weight': '600' }}>Target</th>
                    <th style={{ ...cell, 'text-align': 'left', 'font-weight': '600' }}>Cadence</th>
                    <th style={{ ...cell, 'text-align': 'left', 'font-weight': '600' }}>Last</th>
                    <th style={{ ...cell, 'text-align': 'left', 'font-weight': '600' }}>Next</th>
                    <th style={{ ...cell, 'text-align': 'left', 'font-weight': '600' }}>Status</th>
                    <th style={{ ...cell, 'text-align': 'left', 'font-weight': '600' }}></th>
                  </tr>
                </thead>
                <tbody>
                  <For each={data()!.rules}>{(rule) => {
                    const status = () => statusOf(rule)
                    const sessionId = () => rule.runtime.running?.sessionId || rule.targetSessionId
                    return (
                      <tr data-testid={`scheduler-rule-${rule.id}`} style={{ 'border-top': `1px solid ${line}`, opacity: rule.enabled ? '1' : '0.55' }}>
                        <td style={cell}>
                          <button onClick={() => props.onOpenRoom(rule.room)} style={{ background: 'none', border: 'none', padding: '0', color: muted, cursor: 'pointer', 'font-size': '11px' }}>#{rule.room}</button>
                          <div style={{ color: ink, 'font-weight': '600' }}>{shortId(rule.id, rule.room)}</div>
                          <Show when={rule.note}><div style={{ color: muted, 'font-size': '11px' }}>{rule.note}</div></Show>
                        </td>
                        <td style={cell}>
                          <Show when={sessionId()} fallback={<span>{targetText(rule)}</span>}>
                            <button onClick={() => props.onOpenSession(sessionId()!)} style={{ background: 'none', border: 'none', padding: '0', color: ink, cursor: 'pointer', 'text-decoration': 'underline dotted', 'font-size': '13px' }}>{targetText(rule)}</button>
                          </Show>
                          <div style={{ color: muted, 'font-size': '11px' }}>{rule.mode}</div>
                        </td>
                        <td style={{ ...cell, 'max-width': '260px' }}>{cadenceText(rule)}</td>
                        <td style={{ ...cell, 'white-space': 'nowrap' }}>
                          <div>{clock(rule.runtime.lastRunAt)}</div>
                          <Show when={rule.runtime.lastOutcome}><div style={{ color: outcomeColor(rule.runtime.lastOutcome!), 'font-size': '11px' }}>{rule.runtime.lastOutcome}</div></Show>
                        </td>
                        <td style={{ ...cell, 'white-space': 'nowrap' }}>
                          <div>{clock(rule.runtime.nextDueAt)}</div>
                          <div style={{ color: muted, 'font-size': '11px' }}>{relative(rule.runtime.nextDueAt)}</div>
                        </td>
                        <td style={{ ...cell, 'max-width': '240px' }}>
                          <div style={{ color: status().color }}>{status().text}</div>
                          <Show when={rule.lastDecision && !rule.runtime.running}><div style={{ color: muted, 'font-size': '11px' }}>{rule.lastDecision}</div></Show>
                        </td>
                        <td style={{ ...cell, 'white-space': 'nowrap' }}>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button disabled={busy() === rule.id || !!rule.runtime.running} onClick={() => act(rule, 'fire')} style={buttonStyle} title="Run now">Fire</button>
                            <Show when={rule.runtime.paused} fallback={<button disabled={busy() === rule.id} onClick={() => act(rule, 'pause')} style={buttonStyle}>Pause</button>}>
                              <button disabled={busy() === rule.id} onClick={() => act(rule, 'resume')} style={buttonStyle}>Resume</button>
                            </Show>
                            <button disabled={busy() === rule.id} onClick={() => act(rule, 'delete')} style={{ ...buttonStyle, color: red }} title="Remove rule">✕</button>
                          </div>
                        </td>
                      </tr>
                    )
                  }}</For>
                </tbody>
              </table>
            </div>
          </Show>
        </div>

        <div style={cardStyle}>
          <div style={{ ...labelStyle, 'margin-bottom': '8px' }}>Recent runs</div>
          <Show when={runs().length > 0} fallback={<div style={{ color: muted, 'font-size': '13px' }}>No runs yet.</div>}>
            <div style={{ 'overflow-x': 'auto' }}>
              <table data-testid="scheduler-runs" style={{ 'border-collapse': 'collapse', width: '100%', 'font-size': '13px' }}>
                <tbody>
                  <For each={runs()}>{(run) => (
                    <tr style={{ 'border-top': `1px solid ${line}` }}>
                      <td style={{ ...cell, 'white-space': 'nowrap', color: muted }}>{clock(run.finishedAt || run.startedAt)}</td>
                      <td style={cell}>{run.ruleId}</td>
                      <td style={{ ...cell, color: run.event === 'finished' ? outcomeColor(run.outcome) : green, 'white-space': 'nowrap' }}>
                        {run.event === 'finished' ? `${run.outcome} · ${Math.round((run.durationMs || 0) / 60000)}m` : run.event === 'nudged' ? 'wrap-up nudge' : 'started'}
                      </td>
                      <td style={{ ...cell, color: muted }}>{run.reason}{run.detail ? ` · ${run.detail}` : ''}</td>
                      <td style={cell}>
                        <Show when={run.sessionId}>
                          <button onClick={() => props.onOpenSession(run.sessionId!)} style={{ ...buttonStyle, 'font-size': '11px' }}>open</button>
                        </Show>
                      </td>
                    </tr>
                  )}</For>
                </tbody>
              </table>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
