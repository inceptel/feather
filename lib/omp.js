// OMP (oh-my-pi) launch configuration — pure helpers, imported by server.js.
//
// Feather launches every OMP session (Room status reporters, new OMP chats,
// resumes, forks) with an explicit model and reasoning level. Passing
// them on the command line also forces a *resumed* session onto the current
// model instead of whatever it stored when first created — so switching the
// default actually migrates existing rooms. Both are overridable per
// deployment via env vars:
//   FEATHER_OMP_MODEL     (default openai-codex/gpt-5.6-sol; '' opts out, using omp's own default)
//   FEATHER_OMP_THINKING  (default high; e.g. medium or xhigh)

const OMP_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'])
const DEFAULT_OMP_MODEL = 'openai-codex/gpt-5.6-sol'
const DEFAULT_OMP_THINKING = 'high'
const PROVIDER_CREDENTIAL_ENV = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN', 'FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'COPILOT_GITHUB_TOKEN', 'AZURE_OPENAI_API_KEY', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'XAI_API_KEY',
  'OPENROUTER_API_KEY', 'KILO_API_KEY', 'MISTRAL_API_KEY', 'ZAI_API_KEY', 'UMANS_AI_CODING_PLAN_API_KEY',
  'ABLITERATION_API_KEY', 'MINIMAX_API_KEY', 'OPENCODE_API_KEY', 'CURSOR_ACCESS_TOKEN', 'CLINE_API_KEY',
  'AI_GATEWAY_API_KEY', 'WAFER_SERVERLESS_API_KEY', 'YOLO_AUTO_API_KEY', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'OMP_AUTH_BROKER_URL',
  'OMP_AUTH_BROKER_TOKEN', 'OMP_AUTH_BROKER_ACCOUNT_POOL_FILE', 'OMP_PROFILE', 'FEATHER_OPENAI_API_KEY',
  'FEATHER_ANTHROPIC_API_KEY',
])

// The gateway model config must win without a raw provider credential racing
// model-registry initialization and rebinding the bundled model to its direct
// transport. Search/tool credentials are deliberately left in the environment.
export const OMP_GATEWAY_COMMAND = `env ${PROVIDER_CREDENTIAL_ENV.map(name => `-u ${name}`).join(' ')} omp`

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

export function ompGatewayModelsConfig({ model, baseUrl, tokenCommand }) {
  const providers = new Set(['anthropic', 'openai-codex'])
  const selectedProvider = model.includes('/') ? model.slice(0, model.indexOf('/')) : ''
  if (selectedProvider) providers.add(selectedProvider)
  const config = ['providers:']
  for (const provider of providers) {
    config.push(
      `  ${JSON.stringify(provider)}:`,
      `    baseUrl: ${JSON.stringify(baseUrl)}`,
      `    apiKey: ${JSON.stringify(tokenCommand)}`,
      '    transport: pi-native',
    )
  }
  return `${config.join('\n')}\n`
}
