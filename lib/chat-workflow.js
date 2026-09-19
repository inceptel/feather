import { createHash } from 'node:crypto';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const phases = new Set(['working', 'reviewing', 'waiting', 'blocked', 'complete', 'stopped']);
function string(value, name, max = 4000) {
  if (typeof value !== 'string' || value.length > max) fail(400, `${name} must be a string of at most ${max} characters`);
  return value.trim();
}

export function publicChatWorkflow(value) {
  const state = record(value) ? value : {};
  return {
    enabled: state.enabled === true,
    pendingStart: state.pendingStart === true,
    generation: Number.isSafeInteger(state.generation) && state.generation >= 0 ? state.generation : 0,
    objective: state.objective || '', constraints: state.constraints || [],
    phase: state.phase || 'waiting', summary: state.summary || '', evidence: state.evidence || '',
    next: state.next || '', updatedAt: state.updatedAt || null,
  };
}

export function authorizeChatWorkflow(current, now = Date.now()) {
  return { ...current, ...publicChatWorkflow(current), generation: publicChatWorkflow(current).generation + 1,
    pendingStart: false, humanAuthorized: true, updatedAt: new Date(now).toISOString() };
}

// Pure transition: callers authenticate the session and persist this result under
// their metadata lock, then use the same generation to guard queued delivery.
export function applyChatWorkflow(current, input, { role, now = Date.now(), progressCadenceMs = 300_000 } = {}) {
  if (!['creator', 'human'].includes(role)) fail(403, 'Creator or human workflow control required');
  if (!record(input)) fail(400, 'Workflow input must be an object');
  const action = input.action || 'read';
  if (!['read', 'start', 'progress', 'stop'].includes(action)) fail(400, 'Unknown workflow action');
  const state = { ...publicChatWorkflow(current), humanAuthorized: current?.humanAuthorized === true, checkpoints: Array.isArray(current?.checkpoints) ? current.checkpoints.slice(-50) : [], lastPublishedAt: current?.lastPublishedAt || null };
  const result = (workflow = state, changed = false, publish = false) => ({ workflow, changed, action, publish });
  if (action === 'read') return result();
  if (!Number.isFinite(now) || !Number.isFinite(progressCadenceMs) || progressCadenceMs < 0) fail(400, 'Invalid workflow timing');
  const updatedAt = new Date(now).toISOString();
  if (action === 'stop') return result({ ...state, enabled: false, pendingStart: false, humanAuthorized: false, phase: 'stopped', generation: state.generation + 1, updatedAt }, true);
  if (!Number.isSafeInteger(input.generation) || input.generation !== state.generation) fail(409, 'Workflow control changed; use the generation observed for this human instruction');
  if (action === 'start') {
    if (role !== 'human' && !state.humanAuthorized) fail(409, 'A new human instruction is required to start work');
    const objective = input.objective === undefined ? state.objective : string(input.objective, 'objective');
    if (!objective) fail(400, 'An objective from the current conversation is required');
    const constraints = input.constraints === undefined ? state.constraints : input.constraints;
    if (!Array.isArray(constraints) || constraints.length > 30) fail(400, 'constraints must be an array of at most 30 strings');
    const checked = constraints.map(value => string(value, 'constraint', 1000));
    const next = input.next === undefined ? state.next : string(input.next, 'next');
    if (state.enabled && !state.pendingStart && objective === state.objective && JSON.stringify(checked) === JSON.stringify(state.constraints) && next === state.next) return result();
    return result({ ...state, enabled: true, pendingStart: false, humanAuthorized: true, objective, constraints: checked, next, phase: 'working', updatedAt }, true);
  }
  const summary = string(input.summary, 'summary');
  if (!summary) fail(400, 'Progress summary is required');
  const evidence = input.evidence === undefined ? '' : string(input.evidence, 'evidence', 12000);
  const next = input.next === undefined ? state.next : string(input.next, 'next');
  const requestedPhase = input.phase === undefined ? state.phase : input.phase;
  if (!phases.has(requestedPhase)) fail(400, 'Invalid progress phase');
  const phase = state.phase === 'stopped' ? 'stopped' : requestedPhase;
  if (input.publish !== undefined && typeof input.publish !== 'boolean') fail(400, 'publish must be a boolean');
  const signature = createHash('sha256').update(JSON.stringify({ objective: state.objective, summary, evidence, next, phase })).digest('hex');
  const id = input.checkpointId === undefined ? signature : string(input.checkpointId, 'checkpointId', 120);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail(400, 'Invalid checkpointId');
  const existing = state.checkpoints.find(checkpoint => checkpoint.id === id);
  if (existing) {
    if (existing.signature !== signature) fail(409, 'Checkpoint identity already has different evidence');
    return result();
  }
  if (state.checkpoints.at(-1)?.signature === signature) return result();
  const publish = input.publish === true && Boolean(evidence) && (!state.lastPublishedAt || now - Date.parse(state.lastPublishedAt) >= progressCadenceMs);
  const checkpoint = { id, signature, objective: state.objective, summary, evidence, next, phase, occurredAt: updatedAt, publish };
  return result({ ...state, summary, evidence, next, phase, updatedAt,
    lastPublishedAt: publish ? updatedAt : state.lastPublishedAt,
    checkpoints: [...state.checkpoints, checkpoint].slice(-50),
  }, true, publish);
}
