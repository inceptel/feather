// OMP (oh-my-pi) launch configuration — pure helpers, imported by server.js.
//
// Feather launches every OMP session (room "Keep working" pulses, new omp
// chats, resumes, forks) with an explicit model and reasoning level. Passing
// them on the command line also forces a *resumed* session onto the current
// model instead of whatever it stored when first created — so switching the
// default actually migrates existing rooms. Both are overridable per
// deployment via env vars:
//   FEATHER_OMP_MODEL     (default openai-codex/gpt-5.6-sol; '' opts out, using omp's own default)
//   FEATHER_OMP_THINKING  (default xhigh; e.g. medium or high)

const OMP_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'])
const DEFAULT_OMP_MODEL = 'openai-codex/gpt-5.6-sol'
const DEFAULT_OMP_THINKING = 'xhigh'

// Resolve the model flag value. Empty string means "use omp's own default".
// A non-empty value must look like a model id (it is interpolated into a shell
// command), otherwise fall back to the default rather than inject.
export function resolveOmpModel(env = {}) {
  const raw = (env.FEATHER_OMP_MODEL ?? DEFAULT_OMP_MODEL).trim()
  if (raw === '') return ''
  return /^[a-zA-Z0-9._/:-]+$/.test(raw) ? raw : DEFAULT_OMP_MODEL
}

// Resolve the reasoning level. Must be one omp accepts; anything else (typo,
// injection attempt) falls back to the default.
export function resolveOmpThinking(env = {}) {
  const raw = (env.FEATHER_OMP_THINKING ?? DEFAULT_OMP_THINKING).trim()
  return OMP_THINKING_LEVELS.has(raw) ? raw : DEFAULT_OMP_THINKING
}

// Validate a per-session model override (request input or persisted meta).
// Returns the model id when it is shell-safe, '' otherwise (no override).
export function sanitizeOmpModel(raw) {
  if (typeof raw !== 'string') return ''
  const model = raw.trim()
  return /^[a-zA-Z0-9._/:-]+$/.test(model) ? model : ''
}

// Build the "--model X --thinking Y " prefix (trailing space when non-empty) to
// splice into an omp command line. Either part is omitted when its value is empty.
export function ompModelFlags(model, thinking) {
  return `${model ? `--model ${model} ` : ''}${thinking ? `--thinking ${thinking} ` : ''}`
}
