import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { BASE } from '../api'

interface Task {
  id: string; title: string; description?: string; owner?: string | null; status: string
  criteria?: unknown; revision?: string | null; review?: unknown; result?: unknown
  history?: { action: string; reason?: string }[]; source?: string
  blockedReason?: string | null; updatedAt?: string | null
}
interface ProjectInbox {
  projectId: string; sessionId: string; title: string; objective?: string
  allowIdeas?: boolean; maxGeneratedTasks?: number; tasks: Task[]
}
const muted = '#8b97a8'
const field = { background: '#111924', color: '#e6ebf2', border: '1px solid #344155', 'border-radius': '6px', padding: '8px', 'font-size': '13px', 'min-width': '0' }
const button = { ...field, cursor: 'pointer' }
function readable(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(item => `• ${readable(item)}`).join('\n')
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key.replaceAll('_', ' ')}: ${readable(item)}`).join('\n')
  return String(value)
}

async function request(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`${BASE}${path}`, body === undefined ? { signal } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`)
  return data
}

export function ProjectInboxes(props: { onOpenSession: (id: string) => void }) {
  const [projects, setProjects] = createSignal<ProjectInbox[]>([])
  const projectsById = createMemo(() => new Map(projects().map(project => [project.projectId, project])))
  const [error, setError] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const controller = new AbortController()
  let generation = 0
  let loadingGeneration: number | null = null
  let disposed = false
  async function load(afterMutation = false) {
    if (busy() || disposed || (!afterMutation && loadingGeneration !== null)) return
    const current = ++generation
    loadingGeneration = current
    try {
      const data = await request('/api/project-inboxes', undefined, controller.signal)
      if (!disposed && current === generation) { setProjects(data.projects || []); setError('') }
    } catch (e) {
      if (!disposed && current === generation) setError((e as Error).message)
    } finally {
      if (loadingGeneration === current) loadingGeneration = null
    }
  }
  async function mutate(path: string, body: unknown) {
    if (busy()) return false
    ++generation
    setBusy(true)
    setError('')
    let succeeded = false
    try {
      await request(path, body, controller.signal)
      succeeded = true
    } catch (e) { if (!disposed) setError((e as Error).message) }
    finally { if (!disposed) setBusy(false) }
    if (succeeded && !disposed) await load(true)
    return succeeded
  }
  onMount(() => {
    void load()
    const timer = setInterval(() => void load(), 5000)
    onCleanup(() => clearInterval(timer))
  })
  onCleanup(() => { disposed = true; ++generation; controller.abort() })

  return <section aria-label="Project inboxes" data-testid="project-inboxes" style={{ background: '#0f141b', border: '1px solid #1e2632', 'border-radius': '12px', padding: '14px 16px', 'min-width': '0' }}>
    <h3 style={{ margin: '0 0 10px', 'font-size': '14px' }}>Project inboxes</h3>
    <Show when={error()}><p role="alert" style={{ color: '#e3826d', 'font-size': '13px' }}>{error()}</p></Show>
    <Show when={projects().length} fallback={<p style={{ color: muted, 'font-size': '13px', margin: '0' }}>No project inboxes yet. Give a CR pair a project objective and tasks to work through.</p>}>
      <For each={projects().map(project => project.projectId)}>{id => <Inbox
        project={() => projectsById().get(id)!}
        busy={busy} mutate={mutate} onOpenSession={props.onOpenSession}
      />}</For>
    </Show>
  </section>
}

function Inbox(props: { project: () => ProjectInbox; busy: () => boolean; mutate: (path: string, body: unknown) => Promise<boolean>; onOpenSession: (id: string) => void }) {
  const [title, setTitle] = createSignal('')
  const [objective, setObjective] = createSignal<string | undefined>()
  const [allowIdeas, setAllowIdeas] = createSignal<boolean | undefined>()
  const path = () => `/api/chats/${encodeURIComponent(props.project().sessionId)}/inbox`
  const tasksById = createMemo(() => new Map(props.project().tasks.map(task => [task.id, task])))
  return <article style={{ 'border-top': '1px solid #1e2632', padding: '12px 0', 'overflow-wrap': 'anywhere' }}>
    <div style={{ display: 'flex', gap: '10px', 'align-items': 'baseline', 'flex-wrap': 'wrap' }}>
      <button style={{ ...button, background: 'none', border: 'none', padding: '0', 'font-weight': '650', 'text-decoration': 'underline dotted' }} onClick={() => props.onOpenSession(props.project().sessionId)}>{props.project().title}</button>
      <span style={{ color: muted, 'font-size': '12px' }}>{props.project().tasks.filter(task => task.status === 'done').length}/{props.project().tasks.length} done</span>
    </div>
    <Show when={props.project().objective}><p style={{ color: '#c9d1dc', 'font-size': '13px', margin: '8px 0' }}>{props.project().objective}</p></Show>
    <For each={props.project().tasks.map(task => task.id)}>{id => <TaskRow task={() => tasksById().get(id)!} path={() => `${path()}/tasks/${encodeURIComponent(id)}`} busy={props.busy} mutate={props.mutate} onOpenSession={props.onOpenSession} />}</For>
    <form onSubmit={async event => {
      event.preventDefault()
      const submitted = title().trim()
      if (submitted && await props.mutate(`${path()}/tasks`, { title: submitted }) && title().trim() === submitted) setTitle('')
    }} style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap', 'margin-top': '10px' }}>
      <input aria-label={`New task for ${props.project().title}`} placeholder="Add a task…" value={title()} onInput={event => setTitle(event.currentTarget.value)} required maxLength={300} style={{ ...field, flex: '1 1 160px' }} />
      <button type="submit" disabled={props.busy() || !title().trim()} style={button}>Add task</button>
    </form>
    <details style={{ 'margin-top': '10px', 'font-size': '13px' }}>
      <summary style={{ color: muted, cursor: 'pointer' }}>Project direction</summary>
      <form onSubmit={async event => {
        event.preventDefault()
        const submittedObjective = objective() ?? props.project().objective ?? ''
        const submittedIdeas = allowIdeas() ?? props.project().allowIdeas ?? false
        if (await props.mutate(`${path()}/config`, { objective: submittedObjective, allowIdeas: submittedIdeas, maxGeneratedTasks: props.project().maxGeneratedTasks })) {
          if (objective() === submittedObjective) setObjective(undefined)
          if (allowIdeas() === submittedIdeas) setAllowIdeas(undefined)
        }
      }} style={{ display: 'grid', gap: '10px', 'margin-top': '10px' }}>
        <label>Standing objective<textarea value={objective() ?? props.project().objective ?? ''} onInput={event => setObjective(event.currentTarget.value)} rows={3} style={{ ...field, display: 'block', width: '100%', 'box-sizing': 'border-box', 'margin-top': '4px', resize: 'vertical' }} /></label>
        <label><input type="checkbox" checked={allowIdeas() ?? props.project().allowIdeas ?? false} onChange={event => setAllowIdeas(event.currentTarget.checked)} /> Let pairs propose follow-up tasks within this objective</label>
        <button style={{ ...button, 'justify-self': 'start' }} disabled={props.busy()}>Save direction</button>
      </form>
    </details>
  </article>
}

function TaskRow(props: { task: () => Task; path: () => string; busy: () => boolean; mutate: (path: string, body: unknown) => Promise<boolean>; onOpenSession: (id: string) => void }) {
  const [open, setOpen] = createSignal(false)
  const [detail, setDetail] = createSignal<Task | null>(null)
  const [error, setError] = createSignal('')
  const [retry, setRetry] = createSignal(0)
  const detailVersion = createMemo(() => JSON.stringify([props.path(), props.task().status, props.task().revision, props.task().updatedAt]))
  // Track only the fields that invalidate details, not each new polling object.
  createEffect(on([open, detailVersion, retry], () => {
    if (!open()) return
    const controller = new AbortController()
    let active = true
    setDetail(null)
    setError('')
    request(props.path(), undefined, controller.signal).then(data => {
      if (active) setDetail(data)
    }).catch(error => { if (active) setError(error.message || 'Task details unavailable') })
    onCleanup(() => { active = false; controller.abort() })
  }))
  return <div style={{ padding: '8px 0', 'border-bottom': '1px solid #1e2632', 'font-size': '13px' }}>
    <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary style={{ cursor: 'pointer', 'line-height': '1.7' }}>{props.task().title} <span style={{ color: props.task().status === 'done' ? '#69c77f' : muted }}>· {props.task().status.replaceAll('_', ' ')}</span></summary>
      <Show when={open()}>
        <Show when={error()}><p role="alert" style={{ color: '#e3826d' }}>{error()} <button style={button} onClick={() => setRetry(value => value + 1)}>Retry details</button></p></Show>
        <Show when={!detail() && !error()}><p style={{ color: muted }}>Loading details…</p></Show>
        <Show when={detail()}>{task => <>
          <Show when={task().description}><p>{task().description}</p></Show>
          <For each={['criteria', 'review', 'result'] as const}>{key => <Show when={task()[key]}>
            <h4 style={{ margin: '10px 0 4px', 'font-size': '12px', color: muted }}>{key === 'criteria' ? 'Agreed criteria' : key === 'review' ? 'Review' : 'Result / evidence'}</h4>
            <pre style={{ margin: '0', 'white-space': 'pre-wrap', 'overflow-wrap': 'anywhere', 'font-family': 'inherit', 'line-height': '1.5' }}>{readable(task()[key])}</pre>
          </Show>}</For>
        </>}</Show>
      </Show>
    </details>
    <Show when={props.task().status === 'blocked'}><p style={{ color: '#e0b45f', margin: '6px 0', 'line-height': '1.5' }}>{props.task().blockedReason || 'Waiting for a blocker to be resolved.'}</p></Show>
    <Show when={props.task().owner}><button title={props.task().owner!} style={{ ...button, padding: '3px 6px', 'margin-top': '4px', color: muted }} onClick={() => props.onOpenSession(props.task().owner!)}>Open pair · {props.task().owner!.slice(0, 8)}</button></Show>
    <Show when={props.task().status === 'blocked'}><button style={{ ...button, 'margin-left': '8px' }} disabled={props.busy()} onClick={() => props.mutate(`${props.path()}/unblock`, {})}>Unblock</button></Show>
  </div>
}
