import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import type { AdvisoryLaunchInput, ProtocolEvidenceSnapshot, ProtocolRunSnapshot, ProtocolSeatSnapshot } from '../api'
import {
  COUNCIL_MOBILE_BREAKPOINT,
  activeProtocolRuns,
  historicalProtocolRuns,
  protocolEvidenceId,
  protocolRunView,
  protocolSeatId,
  protocolSeatView,
  protocolSeatAgentTarget,
  verdictSections,
} from '../lib/protocolRuns.js'

const councilCSS = `
.council-control:focus-visible, .council-seat-link:focus-visible, .council-history-row:focus-visible, .council-field:focus-visible {
  outline: 2px solid var(--accent) !important; outline-offset: 2px;
}
.council-stage-track { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.council-stage-bar { height: 3px; border-radius: 2px; background: var(--border-medium); }
.council-stage-bar[data-state='running'] { background: var(--info); }
.council-stage-bar[data-state='succeeded'] { background: var(--success); }
.council-stage-bar[data-state='failed'], .council-stage-bar[data-state='interrupted'], .council-stage-bar[data-state='cancelled'] { background: var(--error); }
.council-seat-link:hover, .council-history-row:hover { background: var(--bg-hover) !important; }
@media (max-width: ${COUNCIL_MOBILE_BREAKPOINT}px) {
  .council-shell { padding: 12px 12px 40px !important; }
  .council-run-head { align-items: flex-start !important; }
  .council-run-actions { width: 100%; justify-content: flex-start !important; }
  .council-verdict-meta { align-items: flex-start !important; flex-direction: column; }
}
`

function statusColor(status: string) {
  if (status === 'succeeded') return 'var(--success)'
  if (status === 'failed' || status === 'start_failed' || status === 'timed_out') return 'var(--error)'
  if (status === 'cancelled' || status === 'interrupted') return 'var(--warning)'
  if (status === 'running' || status === 'cancelling' || status === 'starting') return 'var(--info)'
  return 'var(--text-muted)'
}

function statusMark(status: string) {
  if (status === 'succeeded') return '✓'
  if (status === 'failed' || status === 'start_failed' || status === 'timed_out') return '!'
  if (status === 'cancelled' || status === 'interrupted') return '×'
  if (status === 'running' || status === 'cancelling' || status === 'starting') return '●'
  return '○'
}

function elapsedLabel(run: ProtocolRunSnapshot, now: number) {
  const start = new Date(run.startedAt || run.createdAt).getTime()
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return ''
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function evidenceText(evidence: ProtocolEvidenceSnapshot) {
  if (typeof evidence.content === 'string') return evidence.content
  return JSON.stringify(evidence.content, null, 2)
}

function evidenceButton(evidenceId: string) {
  const target = document.getElementById(`council-evidence-${evidenceId}`)
  target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function seatLabel(run: ProtocolRunSnapshot, seatId: string) {
  const seat = run.seats.find(candidate => protocolSeatId(candidate) === seatId)
  return seat?.role || seatId
}

export function CouncilRunPanel(props: {
  run: ProtocolRunSnapshot
  now: number
  canControl: boolean
  availableAgentIds: Set<string>
  stopping: boolean
  rerunning: boolean
  actionError?: string
  onStop: (run: ProtocolRunSnapshot) => void
  onRerun: (run: ProtocolRunSnapshot) => void
  onOpenSeat: (ompChildId: string) => void
}) {
  const view = createMemo(() => protocolRunView(props.run))
  const verdict = createMemo(() => verdictSections(props.run))
  const canStop = createMemo(() => view().isActive && ['pending', 'running', 'cancelling'].includes(props.run.status))

  function SeatRow(seatProps: { seat: ProtocolSeatSnapshot }) {
    const seat = createMemo(() => protocolSeatView(props.run, seatProps.seat))
    const agentTarget = createMemo(() => protocolSeatAgentTarget(seatProps.seat, props.availableAgentIds))
    return (
      <button
        type="button"
        class="council-seat-link"
        data-testid={`council-seat-${seat().id}`}
        disabled={!agentTarget()}
        onClick={() => agentTarget() && props.onOpenSeat(agentTarget()!)}
        title={agentTarget() ? `Open ${seat().role} in Agents` : seat().ompChildId ? 'Agent details are no longer in the live inspector' : 'Agent has not started'}
        style={{
          width: '100%', display: 'flex', 'align-items': 'center', gap: '8px', padding: '8px 0',
          background: 'transparent', border: 'none', 'border-bottom': '1px solid var(--border-subtle)',
          color: 'var(--text-primary)', 'text-align': 'left', cursor: agentTarget() ? 'pointer' : 'default',
          opacity: agentTarget() || seat().status !== 'pending' ? '1' : '0.72',
        }}
      >
        <span aria-hidden="true" style={{ color: statusColor(seat().status), width: '12px', 'font-size': '11px', 'font-weight': '800' }}>{statusMark(seat().status)}</span>
        <span style={{ flex: '1', 'min-width': '0' }}>
          <span style={{ display: 'block', 'font-size': '12px', 'font-weight': '650', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>{seat().role}</span>
          <Show when={seat().reason}><span style={{ display: 'block', color: 'var(--text-muted)', 'font-size': '10px', 'margin-top': '2px', 'white-space': 'normal' }}>{seat().reason}</span></Show>
        </span>
        <Show when={seat().evidence.length}><span style={{ color: 'var(--text-muted)', 'font-size': '9px', 'text-transform': 'uppercase', 'letter-spacing': '0.06em' }}>evidence</span></Show>
        <span style={{ color: statusColor(seat().status), 'font-size': '10px', 'font-weight': '700' }}>{seat().statusLabel}</span>
        <Show when={agentTarget()}><span aria-hidden="true" style={{ color: 'var(--link)', 'font-size': '14px' }}>›</span></Show>
      </button>
    )
  }

  return (
    <article data-testid={`council-run-${props.run.runId}`} data-run-state={props.run.status} style={{ border: '1px solid var(--border-medium)', 'border-radius': '10px', overflow: 'hidden', background: 'var(--bg-secondary)', 'margin-bottom': '12px' }}>
      <div class="council-run-head" style={{ padding: '12px', display: 'flex', 'align-items': 'center', gap: '12px', 'flex-wrap': 'wrap', 'border-bottom': '1px solid var(--border-subtle)' }}>
        <div style={{ flex: '1', 'min-width': '220px' }}>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'margin-bottom': '4px' }}>
            <span style={{ color: statusColor(props.run.status), 'font-size': '9px', 'font-weight': '800', 'text-transform': 'uppercase', 'letter-spacing': '0.08em' }}>{view().statusLabel}</span>
            <span style={{ color: 'var(--text-faint)', 'font-size': '10px', 'font-family': "'SF Mono', Menlo, monospace" }}>Advisory · {elapsedLabel(props.run, props.now)}</span>
          </div>
          <h3 style={{ margin: '0', color: 'var(--text-primary)', 'font-size': '14px', 'line-height': '1.4', 'font-weight': '700', 'word-break': 'break-word' }}>{props.run.question}</h3>
          <div style={{ color: 'var(--text-muted)', 'font-size': '11px', 'line-height': '1.4', 'margin-top': '4px' }}>{view().summary}</div>
        </div>
        <div class="council-run-actions" style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
          <Show when={canStop()}>
            <button type="button" class="council-control" disabled={!props.canControl || props.stopping || props.run.status === 'cancelling'} onClick={() => props.onStop(props.run)} style={{ background: 'transparent', border: '1px solid var(--error)', color: 'var(--error)', padding: '6px 10px', 'border-radius': '6px', 'font-size': '11px', 'font-weight': '700', cursor: props.canControl && !props.stopping && props.run.status !== 'cancelling' ? 'pointer' : 'default', opacity: props.canControl ? '1' : '0.5' }}>{props.stopping || props.run.status === 'cancelling' ? 'Stopping…' : 'Stop'}</button>
          </Show>
          <Show when={view().isTerminal}>
            <button type="button" class="council-control" disabled={!props.canControl || props.rerunning} onClick={() => props.onRerun(props.run)} style={{ background: 'var(--accent)', border: '1px solid var(--accent)', color: 'var(--accent-text)', padding: '6px 10px', 'border-radius': '6px', 'font-size': '11px', 'font-weight': '700', cursor: props.canControl && !props.rerunning ? 'pointer' : 'default', opacity: props.canControl ? '1' : '0.5' }}>{props.rerunning ? 'Starting…' : 'Rerun'}</button>
          </Show>
        </div>
      </div>

      <Show when={verdict()}>
        {(result) => (
          <section data-testid="council-verdict" style={{ padding: '14px 12px', 'border-bottom': '1px solid var(--border-subtle)', 'border-left': '3px solid var(--success)', background: 'var(--bg-base)' }}>
            <div class="council-verdict-meta" style={{ display: 'flex', 'align-items': 'baseline', 'justify-content': 'space-between', gap: '8px' }}>
              <h4 style={{ margin: '0', color: 'var(--text-primary)', 'font-size': '13px' }}>Verdict</h4>
              <span style={{ color: 'var(--success)', 'font-size': '9px', 'font-weight': '800', 'text-transform': 'uppercase', 'letter-spacing': '0.08em' }}>Confidence · {result().confidence}</span>
            </div>
            <div data-testid="council-verdict-recommendation" style={{ color: 'var(--text-primary)', 'font-size': '13px', 'line-height': '1.55', 'white-space': 'pre-wrap', 'margin-top': '8px', 'word-break': 'break-word' }}>{result().recommendation}</div>
            <Show when={result().disagreements.length}>
              <div style={{ 'margin-top': '14px' }}>
                <div style={{ color: 'var(--text-muted)', 'font-size': '9px', 'font-weight': '800', 'text-transform': 'uppercase', 'letter-spacing': '0.08em', 'margin-bottom': '5px' }}>Retained disagreements · {result().disagreements.length}</div>
                <For each={result().disagreements}>{(disagreement) => (
                  <div style={{ padding: '6px 0', color: 'var(--text-secondary)', 'font-size': '11px', 'line-height': '1.45' }}>
                    <div>{disagreement.summary}</div>
                    <div style={{ display: 'flex', gap: '5px', 'flex-wrap': 'wrap', 'margin-top': '4px' }}>
                      <For each={disagreement.evidenceIds}>{(evidenceId) => <button type="button" onClick={() => evidenceButton(evidenceId)} style={{ background: 'transparent', border: 'none', color: 'var(--link)', padding: '0', 'font-size': '10px', cursor: 'pointer' }}>{evidenceId}</button>}</For>
                    </div>
                  </div>
                )}</For>
              </div>
            </Show>
            <Show when={result().ranking.length}>
              <div style={{ 'margin-top': '14px' }}>
                <div style={{ color: 'var(--text-muted)', 'font-size': '9px', 'font-weight': '800', 'text-transform': 'uppercase', 'letter-spacing': '0.08em', 'margin-bottom': '5px' }}>Candidate ranking</div>
                <For each={result().ranking}>{(rank, index) => (
                  <div style={{ display: 'grid', 'grid-template-columns': '20px minmax(0, 1fr)', gap: '7px', padding: '5px 0', color: 'var(--text-secondary)', 'font-size': '11px', 'line-height': '1.45' }}>
                    <span style={{ color: 'var(--text-muted)', 'font-family': "'SF Mono', Menlo, monospace" }}>{index() + 1}</span>
                    <span><strong style={{ color: 'var(--text-primary)' }}>{seatLabel(props.run, rank.seatId)}</strong> · {rank.rationale}</span>
                  </div>
                )}</For>
              </div>
            </Show>
            <Show when={result().citedEvidenceIds.length}>
              <div style={{ display: 'flex', gap: '6px', 'align-items': 'center', 'flex-wrap': 'wrap', 'margin-top': '12px' }}>
                <span style={{ color: 'var(--text-muted)', 'font-size': '9px', 'font-weight': '800', 'text-transform': 'uppercase', 'letter-spacing': '0.08em' }}>Evidence</span>
                <For each={result().citedEvidenceIds}>{(evidenceId) => <button type="button" onClick={() => evidenceButton(evidenceId)} style={{ background: 'transparent', border: '1px solid var(--border-medium)', color: 'var(--link)', padding: '3px 6px', 'border-radius': '4px', 'font-size': '9px', cursor: 'pointer' }}>{evidenceId}</button>}</For>
              </div>
            </Show>
          </section>
        )}
      </Show>

      <div style={{ padding: '11px 12px', 'border-bottom': '1px solid var(--border-subtle)' }} aria-label="Advisory stages">
        <div class="council-stage-track">
          <For each={view().stages}>{(stage) => <span class="council-stage-bar" data-state={stage.status} />}</For>
        </div>
        <div style={{ display: 'grid', 'grid-template-columns': 'repeat(2, minmax(0, 1fr))', gap: '6px', 'margin-top': '6px' }}>
          <For each={view().stages}>{(stage) => <span style={{ color: stage.status === 'running' ? 'var(--text-primary)' : 'var(--text-muted)', 'font-size': '9px', 'font-weight': stage.status === 'running' ? '700' : '500' }}>{stage.label}</span>}</For>
        </div>
      </div>

      <section style={{ padding: '4px 12px 10px' }} aria-label="Candidate seats">
        <div style={{ display: 'flex', 'align-items': 'baseline', 'justify-content': 'space-between', gap: '8px', padding: '8px 0 2px' }}>
          <h4 style={{ margin: '0', color: 'var(--text-secondary)', 'font-size': '10px', 'text-transform': 'uppercase', 'letter-spacing': '0.07em' }}>Independent attempts</h4>
          <span style={{ color: 'var(--text-muted)', 'font-size': '10px' }}>{view().counts.successful} succeeded · {view().counts.failed} failed · {view().counts.running} active</span>
        </div>
        <For each={view().candidates}>{(seat) => <SeatRow seat={seat} />}</For>
      </section>

      <Show when={view().judges.length || view().stage === 'judge'}>
        <section style={{ padding: '4px 12px 10px', 'border-top': '1px solid var(--border-subtle)' }} aria-label="Judge attempts">
          <h4 style={{ margin: '8px 0 2px', color: 'var(--text-secondary)', 'font-size': '10px', 'text-transform': 'uppercase', 'letter-spacing': '0.07em' }}>Fresh judge</h4>
          <For each={view().judges} fallback={<div style={{ padding: '8px 0', color: 'var(--text-muted)', 'font-size': '11px' }}>Judge is being prepared.</div>}>{(seat) => <SeatRow seat={seat} />}</For>
        </section>
      </Show>

      <Show when={view().failures.length}>
        <section data-testid="council-failure-roll-call" style={{ padding: '10px 12px', 'border-top': '1px solid var(--border-subtle)' }}>
          <h4 style={{ margin: '0 0 5px', color: 'var(--error)', 'font-size': '10px', 'text-transform': 'uppercase', 'letter-spacing': '0.07em' }}>Failure roll call</h4>
          <For each={view().failures}>{(seat) => {
            const item = protocolSeatView(props.run, seat)
            return <div style={{ color: 'var(--text-secondary)', 'font-size': '11px', 'line-height': '1.45', padding: '2px 0' }}><strong style={{ color: 'var(--text-primary)' }}>{item.role}</strong> · {item.statusLabel}<Show when={item.reason}> · {item.reason}</Show></div>
          }}</For>
        </section>
      </Show>

      <Show when={view().candidateEvidence.length}>
        <section data-testid="council-evidence" style={{ padding: '10px 12px', 'border-top': '1px solid var(--border-subtle)' }}>
          <h4 style={{ margin: '0 0 5px', color: 'var(--text-secondary)', 'font-size': '10px', 'text-transform': 'uppercase', 'letter-spacing': '0.07em' }}>Candidate evidence · {view().candidateEvidence.length}</h4>
          <For each={view().candidateEvidence}>{(evidence) => (
            <details id={`council-evidence-${protocolEvidenceId(evidence)}`} style={{ padding: '6px 0', 'border-bottom': '1px solid var(--border-subtle)' }}>
              <summary style={{ color: 'var(--link)', 'font-size': '11px', cursor: 'pointer' }}>{seatLabel(props.run, evidence.seatId)} · {protocolEvidenceId(evidence)}</summary>
              <pre style={{ margin: '7px 0 0', color: 'var(--text-secondary)', 'font-size': '11px', 'line-height': '1.5', 'font-family': 'inherit', 'white-space': 'pre-wrap', 'word-break': 'break-word', 'max-height': '320px', overflow: 'auto' }}>{evidenceText(evidence)}</pre>
            </details>
          )}</For>
        </section>
      </Show>

      <Show when={props.actionError}>
        <div role="alert" style={{ padding: '8px 12px', 'border-top': '1px solid var(--border-subtle)', color: 'var(--error)', 'font-size': '11px' }}>{props.actionError}</div>
      </Show>
    </article>
  )
}

export function CouncilWorkspace(props: {
  runs: ProtocolRunSnapshot[]
  selectedRunId: string | null
  canControl: boolean
  active: boolean
  availableAgentIds: Set<string>
  onSelectRun: (runId: string | null) => void
  onLaunch: (input: AdvisoryLaunchInput) => Promise<ProtocolRunSnapshot>
  onCancel: (runId: string, actionId: string) => Promise<ProtocolRunSnapshot>
  onRerun: (runId: string, actionId: string) => Promise<ProtocolRunSnapshot>
  onOpenSeat: (ompChildId: string) => void
}) {
  const [question, setQuestion] = createSignal('')
  const [candidateCount, setCandidateCount] = createSignal(4)
  const [roleMode, setRoleMode] = createSignal<'diverse' | 'neutral'>('diverse')
  const [timeoutMinutes, setTimeoutMinutes] = createSignal(10)
  const [rubric, setRubric] = createSignal('')
  const [launching, setLaunching] = createSignal(false)
  const [launchError, setLaunchError] = createSignal('')
  const [pendingActions, setPendingActions] = createSignal<Set<string>>(new Set())
  const [actionErrors, setActionErrors] = createSignal<Record<string, string>>({})
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (!props.active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const active = createMemo(() => activeProtocolRuns(props.runs))
  const history = createMemo(() => historicalProtocolRuns(props.runs))
  const selectedHistory = createMemo(() => history().find(run => run.runId === props.selectedRunId) || null)

  async function launch(event: SubmitEvent) {
    event.preventDefault()
    const value = question().trim()
    if (!value || launching()) return
    setLaunching(true)
    setLaunchError('')
    try {
      const run = await props.onLaunch({ protocol: 'advisory', question: value, candidateCount: candidateCount(), roleMode: roleMode(), timeoutMs: timeoutMinutes() * 60_000, rubric: rubric().trim() || undefined })
      props.onSelectRun(run.runId)
      if (run.status !== 'start_failed') setQuestion('')
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error))
    } finally {
      setLaunching(false)
    }
  }

  async function runAction(kind: 'stop' | 'rerun', run: ProtocolRunSnapshot) {
    const key = `${kind}:${run.runId}`
    if (pendingActions().has(key)) return
    const actionId = crypto.randomUUID()
    setPendingActions(current => new Set([...current, key]))
    setActionErrors(current => ({ ...current, [run.runId]: '' }))
    try {
      const next = kind === 'stop'
        ? await props.onCancel(run.runId, actionId)
        : await props.onRerun(run.runId, actionId)
      props.onSelectRun(next.runId)
    } catch (error) {
      setActionErrors(current => ({ ...current, [run.runId]: error instanceof Error ? error.message : String(error) }))
    } finally {
      setPendingActions(current => { const next = new Set(current); next.delete(key); return next })
    }
  }

  const panel = (run: ProtocolRunSnapshot) => (
    <CouncilRunPanel
      run={run}
      now={now()}
      canControl={props.canControl}
      availableAgentIds={props.availableAgentIds}
      stopping={pendingActions().has(`stop:${run.runId}`)}
      rerunning={pendingActions().has(`rerun:${run.runId}`)}
      actionError={actionErrors()[run.runId]}
      onStop={(target) => runAction('stop', target)}
      onRerun={(target) => runAction('rerun', target)}
      onOpenSeat={props.onOpenSeat}
    />
  )

  return (
    <main data-testid="council-workspace" style={{ height: '100%', overflow: 'auto', '-webkit-overflow-scrolling': 'touch' }}>
      <style>{councilCSS}</style>
      <div class="council-shell" style={{ width: '100%', 'max-width': '760px', margin: '0 auto', padding: '16px 16px 48px', 'box-sizing': 'border-box' }}>
        <header style={{ 'margin-bottom': '18px' }}>
          <div style={{ color: 'var(--text-muted)', 'font-size': '9px', 'font-weight': '800', 'text-transform': 'uppercase', 'letter-spacing': '0.09em' }}>Multi-agent protocols</div>
          <h1 style={{ margin: '4px 0 3px', color: 'var(--text-primary)', 'font-size': '22px', 'line-height': '1.2' }}>Council</h1>
          <p style={{ margin: '0', color: 'var(--text-muted)', 'font-size': '12px', 'line-height': '1.45' }}>Convene independent perspectives, preserve the evidence, reach a verdict.</p>
        </header>

        <section aria-labelledby="advisory-launch-heading" style={{ border: '1px solid var(--border-medium)', 'border-left': '3px solid var(--accent)', 'border-radius': '10px', background: 'var(--bg-secondary)', padding: '12px', 'margin-bottom': '20px' }}>
          <div style={{ 'margin-bottom': '10px' }}>
            <h2 id="advisory-launch-heading" style={{ margin: '0', color: 'var(--text-primary)', 'font-size': '14px' }}>Advisory</h2>
            <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', 'font-size': '11px', 'line-height': '1.45' }}>Get several independent perspectives and a fresh synthesized recommendation.</p>
          </div>
          <form onSubmit={launch}>
            <label for="council-question" style={{ display: 'block', color: 'var(--text-secondary)', 'font-size': '10px', 'font-weight': '700', 'margin-bottom': '5px' }}>Question or task</label>
            <textarea id="council-question" class="council-field" value={question()} required maxLength={20000} onInput={(event) => setQuestion(event.currentTarget.value)} placeholder="What decision should the council examine?" disabled={!props.canControl || launching()} style={{ width: '100%', 'min-height': '76px', resize: 'vertical', 'box-sizing': 'border-box', background: 'var(--bg-base)', border: '1px solid var(--border-medium)', 'border-radius': '8px', color: 'var(--text-primary)', padding: '9px 10px', 'font-family': 'inherit', 'font-size': '13px', 'line-height': '1.45', outline: 'none' }} />
            <details style={{ 'margin-top': '8px' }}>
              <summary style={{ color: 'var(--text-muted)', 'font-size': '11px', cursor: 'pointer', padding: '4px 0' }}>Options · {candidateCount()} candidates · {roleMode()} roles · {timeoutMinutes()}m</summary>
              <div style={{ display: 'grid', 'grid-template-columns': 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', padding: '9px 0 4px' }}>
                <label style={{ color: 'var(--text-muted)', 'font-size': '10px' }}>Candidates
                  <select class="council-field" value={candidateCount()} onChange={(event) => setCandidateCount(Number(event.currentTarget.value))} style={{ display: 'block', width: '100%', 'margin-top': '4px', background: 'var(--bg-base)', border: '1px solid var(--border-medium)', color: 'var(--text-primary)', 'border-radius': '6px', padding: '7px' }}>
                    <For each={[2, 3, 4, 5, 6, 7, 8]}>{(count) => <option value={count}>{count}</option>}</For>
                  </select>
                </label>
                <label style={{ color: 'var(--text-muted)', 'font-size': '10px' }}>Role mode
                  <select class="council-field" value={roleMode()} onChange={(event) => setRoleMode(event.currentTarget.value as 'diverse' | 'neutral')} style={{ display: 'block', width: '100%', 'margin-top': '4px', background: 'var(--bg-base)', border: '1px solid var(--border-medium)', color: 'var(--text-primary)', 'border-radius': '6px', padding: '7px' }}>
                    <option value="diverse">Diverse</option><option value="neutral">Neutral</option>
                  </select>
                </label>
                <label style={{ color: 'var(--text-muted)', 'font-size': '10px' }}>Seat timeout
                  <select class="council-field" value={timeoutMinutes()} onChange={(event) => setTimeoutMinutes(Number(event.currentTarget.value))} style={{ display: 'block', width: '100%', 'margin-top': '4px', background: 'var(--bg-base)', border: '1px solid var(--border-medium)', color: 'var(--text-primary)', 'border-radius': '6px', padding: '7px' }}>
                    <For each={[1, 5, 10, 15, 30]}>{(minutes) => <option value={minutes}>{minutes} minute{minutes === 1 ? '' : 's'}</option>}</For>
                  </select>
                </label>
              </div>
              <label for="council-rubric" style={{ display: 'block', color: 'var(--text-muted)', 'font-size': '10px', 'margin-top': '6px' }}>Judge rubric <span style={{ color: 'var(--text-faint)' }}>optional</span></label>
              <textarea id="council-rubric" class="council-field" value={rubric()} maxLength={8000} onInput={(event) => setRubric(event.currentTarget.value)} placeholder="Default: usefulness, correctness, execution realism, and material risk" style={{ width: '100%', 'min-height': '60px', resize: 'vertical', 'box-sizing': 'border-box', 'margin-top': '4px', background: 'var(--bg-base)', border: '1px solid var(--border-medium)', 'border-radius': '8px', color: 'var(--text-primary)', padding: '8px 9px', 'font-family': 'inherit', 'font-size': '11px', 'line-height': '1.45', outline: 'none' }} />
            </details>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '10px', 'margin-top': '10px' }}>
              <button type="submit" class="council-control" disabled={!props.canControl || launching() || !question().trim()} style={{ background: question().trim() && props.canControl ? 'var(--accent)' : 'var(--border-medium)', color: question().trim() && props.canControl ? 'var(--accent-text)' : 'var(--text-muted)', border: 'none', 'border-radius': '7px', padding: '8px 12px', 'font-size': '12px', 'font-weight': '700', cursor: question().trim() && props.canControl && !launching() ? 'pointer' : 'default' }}>{launching() ? 'Starting…' : 'Run Advisory'}</button>
              <Show when={!props.canControl}><span style={{ color: 'var(--text-muted)', 'font-size': '10px' }}>View only</span></Show>
            </div>
            <Show when={launchError()}><div role="alert" style={{ color: 'var(--error)', 'font-size': '11px', 'margin-top': '8px' }}>{launchError()}</div></Show>
          </form>
        </section>

        <section aria-labelledby="active-council-runs">
          <div style={{ display: 'flex', 'align-items': 'baseline', 'justify-content': 'space-between', gap: '8px', 'margin-bottom': '8px' }}>
            <h2 id="active-council-runs" style={{ margin: '0', color: 'var(--text-primary)', 'font-size': '13px' }}>Active runs</h2>
            <span style={{ color: 'var(--text-muted)', 'font-size': '10px' }}>{active().length}</span>
          </div>
          <For each={active()} fallback={<div style={{ color: 'var(--text-muted)', 'font-size': '11px', padding: '4px 0 18px' }}>No Council run is active. Ask a question above or let OMP suggest Advisory in Chat.</div>}>{(run) => panel(run)}</For>
        </section>

        <section aria-labelledby="council-history" style={{ 'margin-top': '8px' }}>
          <div style={{ display: 'flex', 'align-items': 'baseline', 'justify-content': 'space-between', gap: '8px', 'margin-bottom': '8px' }}>
            <h2 id="council-history" style={{ margin: '0', color: 'var(--text-primary)', 'font-size': '13px' }}>History</h2>
            <span style={{ color: 'var(--text-muted)', 'font-size': '10px' }}>Latest {history().length}</span>
          </div>
          <Show when={history().length} fallback={<div style={{ color: 'var(--text-muted)', 'font-size': '11px', padding: '4px 0' }}>Completed runs will stay here with their evidence and verdict.</div>}>
            <div style={{ border: '1px solid var(--border-medium)', 'border-radius': '9px', overflow: 'hidden', 'margin-bottom': '12px' }}>
              <For each={history()}>{(run) => {
                const item = protocolRunView(run)
                return (
                  <button type="button" class="council-history-row" data-testid={`council-history-${run.runId}`} onClick={() => props.onSelectRun(props.selectedRunId === run.runId ? null : run.runId)} style={{ width: '100%', display: 'flex', 'align-items': 'center', gap: '8px', padding: '9px 10px', background: props.selectedRunId === run.runId ? 'var(--accent-subtle)' : 'var(--bg-secondary)', border: 'none', 'border-bottom': '1px solid var(--border-subtle)', color: 'var(--text-primary)', cursor: 'pointer', 'text-align': 'left' }}>
                    <span style={{ color: statusColor(run.status), width: '12px', 'font-size': '10px', 'font-weight': '800' }}>{statusMark(run.status)}</span>
                    <span style={{ flex: '1', 'min-width': '0', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'font-size': '11px' }}>{run.question}</span>
                    <span style={{ color: 'var(--text-muted)', 'font-size': '9px', 'text-transform': 'uppercase', 'letter-spacing': '0.05em' }}>{item.statusLabel}</span>
                  </button>
                )
              }}</For>
            </div>
          </Show>
          <Show when={selectedHistory()}>{(run) => panel(run())}</Show>
        </section>
      </div>
    </main>
  )
}
