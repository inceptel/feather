// Durable stop state is written before any process is interrupted. Keeping
// the rule and history allows an explicit resume without losing evidence.
export function stopScheduledRules(state, ids, { pause = false } = {}) {
  const rules = { ...(state.rules || {}) };
  const runtime = { ...(state.runtime || {}) };
  for (const id of ids) {
    if (!rules[id]) continue;
    rules[id] = { ...rules[id], ...(pause ? {} : { enabled: false }) };
    runtime[id] = { ...runtime[id], paused: true, pausedReason: pause ? 'paused by user' : 'stopped by user' };
  }
  return { ...state, rules, runtime };
}

export function scheduledRunMayContinue(state, run) {
  return !!state.rules?.[run.ruleId] && state.rules[run.ruleId].enabled !== false
    && !state.runtime?.[run.ruleId]?.paused
    && !!state.active?.some(candidate => candidate.runId === run.runId);
}

// A person starts a new turn; an agent message only continues existing work.
export function mayReenableRalph(state, source) {
  return source === 'human' || state?.enabled === true || state?.status !== 'stopped';
}
