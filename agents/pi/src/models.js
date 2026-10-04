// Model access for the pi agent.
//
// Claude and Codex subscriptions go through the OMP auth gateway (Feather's
// FEATHER_OMP_AUTH_GATEWAY_URL, default http://127.0.0.1:4000). The spec asked
// for the gateway's `pi-native` transport, but upstream pi-ai does not speak it.
// The gateway also serves the Anthropic wire (`/v1/messages`) for every model it
// lists, so one "gateway" provider with the anthropic-messages API reaches both
// subscriptions with no new credentials on disk. The bearer token is read from
// its 0600 file at each request and never logged.
//
// OpenRouter uses OPENROUTER_API_KEY, which main.js reads from ~/keyvault.txt at
// launch. It is passed here as a secret and never placed in process.env, so the
// agent's own shell commands cannot print it.
//
// Model references are strings:
//   anthropic/claude-opus-5-5, openai-codex/gpt-5.6-sol  -> gateway
//   openrouter/<vendor>/<model>                         -> OpenRouter
import fs from 'node:fs';
import { defaultProviderAuthContext } from '@earendil-works/pi-ai';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { withViewMarks } from './optchat/cache.js';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';

// Codex is the default. Claude subscriptions in third-party harnesses are
// legally unclear (see the #feather notes, 2026-10-04); Codex subscriptions are
// fine. FEATHER_PI_DEFAULT_MODEL or a per-chat model overrides it.
export const FALLBACK_DEFAULT_MODEL = 'openai-codex/gpt-5.6-sol';
export const GATEWAY_PROVIDER = 'gateway';
const MODEL_REF_RE = /^[a-zA-Z0-9._:-]+\/[a-zA-Z0-9._:/-]+$/;

export function defaultModelRef(env = process.env) {
  const value = String(env.FEATHER_PI_DEFAULT_MODEL || '').trim();
  return value && MODEL_REF_RE.test(value) ? value : FALLBACK_DEFAULT_MODEL;
}

/** Split a model reference into the pi-ai provider id and model id, or null. */
export function parseModelRef(ref) {
  const value = String(ref || '').trim();
  if (!MODEL_REF_RE.test(value) || value.length > 200) return null;
  const [head, ...rest] = value.split('/');
  if (head === 'openrouter') return { provider: 'openrouter', modelId: rest.join('/'), upstream: 'openrouter', ref: value };
  return { provider: GATEWAY_PROVIDER, modelId: value, upstream: head, ref: value };
}

/** The upstream provider a recorded model ran on, e.g. "openai-codex". */
export function upstreamOf(provider, modelId) {
  if (provider === GATEWAY_PROVIDER) return String(modelId || '').split('/')[0] || 'gateway';
  return provider || 'unknown';
}

function gatewayModel(ref, baseUrl) {
  const [upstream, ...rest] = ref.split('/');
  const name = rest.join('/');
  if (upstream === 'anthropic') {
    const known = anthropicProvider().getModels().find(model => model.id === name);
    if (known) return { ...known, id: ref, name: `${known.name} (subscription)`, provider: GATEWAY_PROVIDER, baseUrl };
  }
  // Unknown to pi-ai's catalog (for example Codex models served over the
  // Anthropic wire): plain text chat, no provider-specific thinking options.
  return {
    id: ref,
    name: ref,
    api: 'anthropic-messages',
    provider: GATEWAY_PROVIDER,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 32_000,
    compat: {},
    type: 'chat',
  };
}

function gatewayAuth(tokenFile) {
  return {
    apiKey: {
      name: 'Feather OMP auth gateway',
      login: async () => { throw new Error('the gateway token is managed by omp auth-gateway'); },
      resolve: async ({ signal }) => {
        signal?.throwIfAborted?.();
        let token = '';
        try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return undefined; }
        if (!token) return undefined;
        return { auth: { headers: { Authorization: `Bearer ${token}` } }, source: 'gateway token file' };
      },
    },
  };
}

/**
 * Build the pi-ai Models collection. `ensure(ref)` makes a gateway model known
 * (the gateway resolves any id it lists) and returns the durable model choice.
 */
export function createAgentModels({
  gatewayUrl = process.env.FEATHER_OMP_AUTH_GATEWAY_URL || 'http://127.0.0.1:4000',
  tokenFile = process.env.FEATHER_OMP_AUTH_GATEWAY_TOKEN_FILE || `${process.env.HOME}/.omp/auth-gateway.token`,
  secrets = {},
  viewMarks = false,
} = {}) {
  const ambient = defaultProviderAuthContext();
  const models = createModels({
    authContext: {
      env: async name => (Object.hasOwn(secrets, name) ? secrets[name] : ambient.env(name)),
      fileExists: path => ambient.fileExists(path),
    },
  });
  const gatewayModels = new Map();
  const auth = gatewayAuth(tokenFile);
  const installGateway = () => models.setProvider(createProvider({
    id: GATEWAY_PROVIDER,
    name: 'Feather auth gateway',
    baseUrl: gatewayUrl,
    auth,
    models: [...gatewayModels.values()],
    api: viewMarks ? withViewMarks(anthropicMessagesApi()) : anthropicMessagesApi(),
  }));
  installGateway();
  models.setProvider(openrouterProvider());

  function ensure(ref) {
    const parsed = parseModelRef(ref);
    if (!parsed) throw new Error(`invalid model reference: ${String(ref).slice(0, 80)}`);
    if (parsed.provider === GATEWAY_PROVIDER && !gatewayModels.has(parsed.modelId)) {
      gatewayModels.set(parsed.modelId, gatewayModel(parsed.modelId, gatewayUrl));
      installGateway();
    }
    if (!models.getModel(parsed.provider, parsed.modelId)) throw new Error(`unknown model: ${parsed.ref}`);
    return { provider: parsed.provider, modelId: parsed.modelId };
  }

  return { models, ensure };
}

/** Read one NAME=value key from a keyvault file without exposing the others. */
export function readKeyvaultKey(file, name) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line.startsWith(`${name}=`)) continue;
    const value = line.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    return value || undefined;
  }
  return undefined;
}
