import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { ProjectInboxes } from './ProjectInboxes'
import { fetchScheduler, fetchSchedulerRuns, schedulerRuleAction, deleteSchedulerRule, stopAllAutopilot, stopAutopilotChat, fetchSessions, fetchProjectComms, projectCommsAction, ProjectCommsSnapshot, SchedulerSnapshot, SchedulerRule, SchedulerRun, SessionMeta } from '../api'

// Scheduler: every wake rule Feather owns, in one table. What fires, when,
// why it did not, and the last runs. Rules are written with `room schedule`.

const ink = '#e6ebf2'
const body = '#c9d1dc'
const muted = '#8b97a8'
const line = '#1e2632'
const green = '#69c77f'
const amber = '#e0b45f'
const red = '#e3826d'
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
  if (t.kind === 'agent') return `CR pair · ${t.builder.engine} + ${t.checker.engine}`
  return 'chat'
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
    else if (c.type === 'todo-has') parts.push(`when TODO ${c.section} has lines`)
    else if (c.type === 'wiki-approved') parts.push('when a wiki was written')
  }
  return parts.join(', ')
}
function statusOf(rule: SchedulerRule): { text: string, color: string } {
  const rt = rule.runtime
  if (!rule.enabled) return { text: 'Stopped', color: muted }
  if (rt.paused) return { text: rt.pausedReason || 'paused', color: amber }
  if (rt.running) return { text: `running ${relative(rt.running.startedAt)}`, color: green }
  if (rt.overdue) return { text: 'overdue', color: red }
  if (rt.consecutiveFailures > 0) return { text: `${rt.consecutiveFailures} failed`, color: amber }
  return { text: 'Scheduled', color: body }
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
  const [chats, setChats] = createSignal<SessionMeta[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [showStopped, setShowStopped] = createSignal(false)
  const [comms, setComms] = createSignal<ProjectCommsSnapshot | null>(null)
  const [commsError, setCommsError] = createSignal<string | null>(null)
  const [commsBusy, setCommsBusy] = createSignal(false)
  const [showCommsHistory, setShowCommsHistory] = createSignal(false)
  let commsGeneration = 0
  let commsRequest: AbortController | null = null
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined

  async function loadComms() {
    if (disposed || commsRequest) return
    const generation = ++commsGeneration
    const controller = new AbortController()
    commsRequest = controller
    try {
      const snapshot = await fetchProjectComms(controller.signal)
      if (!disposed && generation === commsGeneration) { setComms(snapshot); setCommsError(snapshot.error || null) }
    } catch (e: any) {
      if (!disposed && generation === commsGeneration) setCommsError(e?.message || 'Updates team unavailable')
    } finally {
      if (commsRequest === controller) commsRequest = null
    }
  }
  async function actComms(action: 'pause' | 'resume' | 'retry', jobId?: string) {
    if (commsBusy()) return
    setCommsBusy(true)
    ++commsGeneration
    commsRequest?.abort()
    commsRequest = null
    try { await projectCommsAction(action, jobId); await loadComms() }
    catch (e: any) { if (!disposed) setCommsError(e?.message || 'Updates team action failed') }
    finally { if (!disposed) setCommsBusy(false) }
  }

  async function load() {
    try {
      const [snapshot, recent, sessions] = await Promise.all([fetchScheduler(), fetchSchedulerRuns({ limit: 40 }), fetchSessions(null, undefined, undefined, 'ralph')])
      setData(snapshot)
      setRuns(recent)
      setChats(sessions.sessions.filter(session => session.mode === 'ralph'))
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'Autopilot unavailable')
    } finally {
      setLoaded(true)
    }
  }
  async function act(rule: SchedulerRule, action: 'fire' | 'pause' | 'resume' | 'stop' | 'delete') {
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
  async function stop(id?: string) {
    setBusy(id || 'all')
    try {
      if (id) await stopAutopilotChat(id)
      else await stopAllAutopilot()
      await load()
    } catch (e: any) { setError(e?.message || 'Stop failed') }
    finally { setBusy(null) }
  }
  onMount(() => { load(); loadComms(); timer = setInterval(() => { load(); if (!commsBusy()) loadComms() }, 15000) })
  onCleanup(() => { disposed = true; ++commsGeneration; commsRequest?.abort(); if (timer) clearInterval(timer) })

  return (
    <div data-testid="scheduler-view" class="work-overview">
      <div class="work-content">
        <header class="work-header">
          <div><h1>Autopilot</h1><p>Your teams, their next tasks, and what's running.</p></div>
          <div class="work-header-actions">
            <button onClick={() => { load(); if (!commsBusy()) loadComms() }} class="workspace-button">Refresh</button>
            <button disabled={!!busy()} onClick={() => stop()} class="workspace-button" title="Stop automatic continuation. Chats remain available.">Stop all</button>
          </div>
        </header>
        <Show when={error()}><div style={{ color: red, 'font-size': '13px' }}>{error()}</div></Show>

        <section aria-label="Active chats">
          <div class="work-section-heading"><h2>Working now</h2><Show when={loaded()}><span>{chats().filter(chat => chat.ralph?.enabled).length} active</span></Show></div>
          <p class="work-help">Stop pauses automatic continuation. Your next message starts it again.</p>
          <Show when={loaded()} fallback={<div class="work-loading" role="status">Loading active chats…</div>}>
            <Show when={chats().some(chat => chat.ralph?.enabled)} fallback={<div class="work-empty">No chats on autopilot right now.</div>}>
              <For each={chats().filter(chat => chat.ralph?.enabled).sort((a, b) => (a.title || '').localeCompare(b.title || ''))}>{chat => (
                <div class="work-chat">
                  <div><button class="project-title" onClick={() => props.onOpenSession(chat.id)}>{chat.title || 'Untitled chat'} ↗</button>
                    <Show when={chat.ralph?.blockedReason || chat.ralph?.error || (chat.ralph?.iteration || 0) > 0}><div class="work-chat-note">{chat.ralph?.blockedReason || chat.ralph?.error || `${chat.ralph?.iteration} iterations`}</div></Show></div>
                  <span class="work-status" data-status={chat.ralph?.status}>{chat.ralph?.status || 'Ready'}</span>
                  <button disabled={!!busy()} onClick={() => stop(chat.id)} class="workspace-button">Stop</button>
                </div>
              )}</For>
            </Show>
            <Show when={chats().some(chat => !chat.ralph?.enabled)}>
              <button class="work-muted-button" aria-expanded={showStopped()} onClick={() => setShowStopped(!showStopped())}>{showStopped() ? 'Hide' : 'Show'} stopped chats ({chats().filter(chat => !chat.ralph?.enabled).length})</button>
              <Show when={showStopped()}><For each={chats().filter(chat => !chat.ralph?.enabled)}>{chat => (
                <div class="work-chat"><div><button class="project-title" onClick={() => props.onOpenSession(chat.id)}>{chat.title || 'Untitled chat'} ↗</button><div class="work-chat-note">{chat.ralph?.completionReason || chat.ralph?.blockedReason}</div></div><span class="work-status">Stopped</span></div>
              )}</For></Show>
            </Show>
          </Show>
        </section>

        <section aria-label="Updates team" class="comms-team">
          <div class="work-section-heading"><h2>Updates team</h2>
            <Show when={comms()}><span>{comms()!.enabled ? 'On' : 'Paused'}</span>
              <button class="workspace-button" disabled={commsBusy()} onClick={() => actComms(comms()!.enabled ? 'pause' : 'resume')}>{commsBusy() ? 'Saving…' : comms()!.enabled ? 'Pause updates team' : 'Resume updates team'}</button>
            </Show>
          </div>
          <p class="work-help">Caretaker keeps the wiki useful. Marketer writes Updates. Replyguy brings your comments to the team and returns with answers.</p>
          <p class="work-help">Pausing stops new helper jobs, not your chats or helpers already running.</p>
          <Show when={commsError()}><p role="alert" class="comms-error">{commsError()} <button class="work-muted-button" disabled={commsBusy()} onClick={loadComms}>Try again</button></p></Show>
          <Show when={comms()} fallback={<Show when={!commsError()}><div class="work-loading" role="status">Loading updates team…</div></Show>}>
            <Show when={comms()!.jobs?.some(job => !['done', 'completed', 'suppressed'].includes(job.status))} fallback={<div class="work-empty">{comms()!.enabled ? 'No updates waiting. The team picks up meaningful project changes automatically.' : 'New helper jobs are paused. Resume when you want updates and replies to continue.'}</div>}>
              <For each={comms()!.jobs?.filter(job => !['done', 'completed', 'suppressed'].includes(job.status))}>{job => (
                <div class="comms-job">
                  <div><div class="comms-job-title">{job.role === 'replyguy' ? 'Replyguy' : job.role === 'caretaker' ? 'Caretaker' : 'Marketer'} <span>· {job.projectTitle || 'Project'}</span></div>
                    <Show when={job.error}><p class="comms-error">{job.error}</p></Show>
                  </div>
                  <span class="work-status" data-status={job.status}>{job.status.replaceAll('_', ' ')}</span>
                  <div class="comms-job-actions">
                    <Show when={job.sessionId}><button class="work-muted-button" onClick={() => props.onOpenSession(job.sessionId!)}>Open chat ↗</button></Show>
                    <Show when={job.status === 'stalled' || job.status === 'failed'}><button class="workspace-button" disabled={commsBusy()} onClick={() => actComms('retry', job.id)} aria-label={`Retry ${job.role} for ${job.projectTitle}`}>Retry</button></Show>
                  </div>
                </div>
              )}</For>
            </Show>
            <Show when={comms()!.jobs?.some(job => ['done', 'completed', 'suppressed'].includes(job.status))}>
              <button class="work-muted-button" aria-expanded={showCommsHistory()} onClick={() => setShowCommsHistory(!showCommsHistory())}>{showCommsHistory() ? 'Hide' : 'Show'} recent helper work</button>
              <Show when={showCommsHistory()}><For each={comms()!.jobs?.filter(job => ['done', 'completed', 'suppressed'].includes(job.status)).slice(0, 12)}>{job => (
                <div class="comms-job"><span class="comms-job-title">{job.role} · {job.projectTitle}</span><span class="work-status">{job.status}</span><Show when={job.sessionId}><button class="work-muted-button" onClick={() => props.onOpenSession(job.sessionId!)}>Open chat ↗</button></Show></div>
              )}</For></Show>
            </Show>
          </Show>
        </section>

        <ProjectInboxes onOpenSession={props.onOpenSession} />

        <details class="work-history">
          <summary>Scheduled work <Show when={data()}>· {data()?.rules.length}</Show></summary>
          <Show when={(data()?.rules.length || 0) > 0} fallback={
            <div style={{ color: muted, 'font-size': '13px', 'line-height': '1.5' }}>
              No scheduled work yet. Scheduled tasks will appear here with their next run and stop controls.
            </div>
          }>
            <div style={{ 'overflow-x': 'auto' }}>
              <table data-testid="scheduler-rules" style={{ 'border-collapse': 'collapse', width: '100%', 'font-size': '13px' }}>
                <thead>
                  <tr style={{ color: muted, 'font-size': '11px' }}>
                    <th style={{ ...cell, 'text-align': 'left', 'font-weight': '600' }}>Task</th>
                    <th style={{ ...cell, 'text-align': 'left', 'font-weight': '600' }}>Team</th>
                    <th style={{ ...cell, 'text-align': 'left', 'font-weight': '600' }}>Schedule</th>
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
                          <div style={{ color: muted, 'font-size': '11px' }}>Up to {Math.round(rule.timeoutMs / 60000)}m per run</div>
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
                            <button disabled={!!busy() || !!rule.runtime.running || !rule.enabled || rule.runtime.paused} onClick={() => act(rule, 'fire')} style={buttonStyle} title="Run now">Run now</button>
                            <Show when={rule.runtime.paused || !rule.enabled} fallback={<button disabled={!!busy()} onClick={() => act(rule, 'pause')} style={buttonStyle}>Pause</button>}>
                              <button disabled={!!busy()} onClick={() => act(rule, 'resume')} style={buttonStyle}>Resume</button>
                            </Show>
                            <button disabled={!!busy() || (!rule.enabled && !rule.runtime.running)} onClick={() => act(rule, 'stop')} style={{ ...buttonStyle, color: red }}>Stop</button>
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
        </details>

        <details class="work-history">
          <summary>Run history</summary>
          <Show when={runs().length > 0} fallback={<div style={{ color: muted, 'font-size': '13px' }}>No runs yet.</div>}>
            <div style={{ 'overflow-x': 'auto' }}>
              <table data-testid="scheduler-runs" style={{ 'border-collapse': 'collapse', width: '100%', 'font-size': '13px' }}>
                <tbody>
                  <For each={runs()}>{(run) => (
                    <tr style={{ 'border-top': `1px solid ${line}` }}>
                      <td style={{ ...cell, 'white-space': 'nowrap', color: muted }}>{clock(run.finishedAt || run.startedAt)}</td>
                      <td style={cell}>{run.ruleId}</td>
                      <td style={{ ...cell, color: run.event === 'finished' ? outcomeColor(run.outcome) : green, 'white-space': 'nowrap' }}>
                        {run.event === 'finished' ? `${run.outcome} · ${Math.round((run.durationMs || 0) / 60000)}m` : 'started'}
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
        </details>
      </div>
    </div>
  )
}
