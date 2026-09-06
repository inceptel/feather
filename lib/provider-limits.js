// Provider-side limits for the Costs tab. Each provider is polled at most
// once per interval and keeps its last good answer when the provider says
// no (Anthropic rate-limits its own usage endpoint aggressively). Tokens
// and API keys never leave this module.

import fs from 'fs'
import path from 'path'

export const PROVIDER_POLL_MS = 5 * 60_000
// Anthropic's usage endpoint rate-limits per account and answers 429 with a
// Retry-After of several minutes; polling faster than that never recovers.
export const ANTHROPIC_POLL_MS = 15 * 60_000
const RETRY_AFTER_MARGIN_MS = 30_000

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

export function readAnthropicToken({ ompAuthFile, claudeCredentialsFile }) {
  const omp = readJson(ompAuthFile)?.anthropic
  if (omp && typeof omp.access === 'string') return { token: omp.access, source: 'omp', expiresAt: Number(omp.expires) || null }
  const claude = readJson(claudeCredentialsFile)?.claudeAiOauth
  if (claude && typeof claude.accessToken === 'string') return { token: claude.accessToken, source: 'claude-code', expiresAt: Number(claude.expiresAt) || null }
  return null
}

export function readCodexAuth({ ompAuthFile }) {
  const codex = readJson(ompAuthFile)?.['openai-codex']
  if (!codex) return null
  return { expiresAt: Number(codex.expires) || null }
}

export function readKeyvaultKey(name, { keyvaultFile, env = process.env }) {
  if (typeof env[name] === 'string' && env[name]) return env[name]
  try {
    for (const line of fs.readFileSync(keyvaultFile, 'utf8').split('\n')) {
      const match = line.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*"?([^"\\s]+)"?\\s*$`))
      if (match) return match[1]
    }
  } catch { /* no keyvault */ }
  return null
}

export function readOpenRouterKey({ keyvaultFile, env = process.env }) {
  return readKeyvaultKey('OPENROUTER_API_KEY', { keyvaultFile, env })
}

// Anthropic's Admin cost report (needs an Admin API key, ANTHROPIC_ADMIN_KEY).
// It covers metered API spend for the Console organisation, not the Claude
// subscription windows. Amounts arrive as cent strings; keep dollars per day.
export function normalizeAnthropicCostReport(doc) {
  const days = []
  if (!doc || !Array.isArray(doc.data)) return days
  for (const bucket of doc.data) {
    if (!bucket || typeof bucket.starting_at !== 'string') continue
    let cents = 0
    for (const item of Array.isArray(bucket.results) ? bucket.results : []) {
      const amount = Number(item?.amount)
      if (Number.isFinite(amount)) cents += amount
    }
    days.push({ date: bucket.starting_at.slice(0, 10), usd: Math.round(cents) / 100 })
  }
  return days
}

// Anthropic's OAuth usage document is a map of window name to
// {utilization, resets_at}. Keep only that shape so nothing sensitive can
// leak through if the document grows other fields.
export function normalizeAnthropicUsage(doc) {
  if (!doc || typeof doc !== 'object') return []
  const windows = []
  for (const [name, value] of Object.entries(doc)) {
    if (!value || typeof value !== 'object') continue
    const utilization = Number(value.utilization)
    if (!Number.isFinite(utilization)) continue
    const resetsAt = value.resets_at ?? value.resetsAt ?? null
    windows.push({
      name,
      utilization,
      resetsAt: typeof resetsAt === 'number' ? new Date(resetsAt * (resetsAt < 1e12 ? 1000 : 1)).toISOString()
        : (typeof resetsAt === 'string' && Number.isFinite(Date.parse(resetsAt)) ? new Date(resetsAt).toISOString() : null),
    })
  }
  return windows
}

export function normalizeCodexRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return []
  const windows = []
  for (const key of ['primary', 'secondary']) {
    const value = rateLimits[key]
    if (!value || typeof value !== 'object') continue
    const utilization = Number(value.used_percent)
    if (!Number.isFinite(utilization)) continue
    const minutes = Number(value.window_minutes)
    windows.push({
      name: Number.isFinite(minutes) ? (minutes >= 1440 ? `${Math.round(minutes / 1440)}d` : `${Math.round(minutes / 60)}h`) : key,
      utilization: utilization / 100,
      resetsAt: Number.isFinite(Number(value.resets_at)) ? new Date(Number(value.resets_at) * 1000).toISOString() : null,
    })
  }
  return windows
}

// OMP's auth broker keeps live provider limit reports (today: Codex). Its
// document is {reports:[{provider, fetchedAt, limits:[{label, scope, window:{resetsAt}, amount:{usedFraction}}]}]}.
export function normalizeBrokerReports(doc) {
  const out = {}
  if (!doc || !Array.isArray(doc.reports)) return out
  for (const report of doc.reports) {
    if (!report || typeof report.provider !== 'string' || !Array.isArray(report.limits)) continue
    const windows = []
    for (const limit of report.limits) {
      if (!limit || typeof limit !== 'object' || limit.scope?.tier) continue
      const utilization = Number(limit.amount?.usedFraction)
      if (!Number.isFinite(utilization)) continue
      const resetsAt = Number(limit.window?.resetsAt)
      windows.push({
        name: String(limit.window?.label || limit.label || limit.id || 'window'),
        utilization,
        resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? new Date(resetsAt).toISOString() : null,
      })
    }
    if (windows.length === 0) continue
    out[report.provider] = { windows, fetchedAt: Number(report.fetchedAt) || null }
  }
  return out
}

export function readBrokerToken(file) {
  try { return fs.readFileSync(file, 'utf8').trim() || null } catch { return null }
}

export function createProviderLimits({
  ompAuthFile,
  claudeCredentialsFile,
  keyvaultFile,
  cacheFile = null,
  brokerUrl = null,
  brokerTokenFile = null,
  fetchImpl = globalThis.fetch,
  pollMs = PROVIDER_POLL_MS,
  anthropicPollMs = Math.max(pollMs, ANTHROPIC_POLL_MS),
  now = Date.now,
  env = process.env,
} = {}) {
  const state = {
    anthropic: { fetchedAt: 0, data: null, error: null, lastGoodAt: null, retryAt: 0 },
    openrouter: { fetchedAt: 0, data: null, error: null, lastGoodAt: null, retryAt: 0 },
    broker: { fetchedAt: 0, data: null, error: null, lastGoodAt: null, retryAt: 0 },
    anthropicApi: { fetchedAt: 0, data: null, error: null, lastGoodAt: null, retryAt: 0 },
  }
  // The last good Anthropic reading survives a restart, so a 429 streak after
  // a deploy still shows the most recent real numbers instead of blank bars.
  const cached = cacheFile ? readJson(cacheFile) : null
  if (cached?.anthropic?.data?.windows && Number.isFinite(cached.anthropic.lastGoodAt)) {
    state.anthropic.data = { windows: normalizeAnthropicUsage(Object.fromEntries(cached.anthropic.data.windows.map(w => [w.name, { utilization: w.utilization, resets_at: w.resetsAt }]))), tokenSource: cached.anthropic.data.tokenSource || null, tokenExpiresAt: cached.anthropic.data.tokenExpiresAt || null }
    state.anthropic.lastGoodAt = cached.anthropic.lastGoodAt
  }
  function persist() {
    if (!cacheFile) return
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      fs.writeFileSync(cacheFile, JSON.stringify({ anthropic: { data: state.anthropic.data, lastGoodAt: state.anthropic.lastGoodAt } }), { mode: 0o600 })
    } catch { /* cache is best effort */ }
  }

  async function getJson(url, headers) {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) })
    const text = await response.text()
    if (!response.ok) {
      const error = new Error(`${response.status}`)
      error.status = response.status
      const retryAfter = Number(response.headers?.get?.('retry-after'))
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000
      throw error
    }
    return JSON.parse(text)
  }

  function minutesUntil(at) {
    return Math.max(1, Math.ceil((at - now()) / 60_000))
  }

  async function refreshAnthropic() {
    const slot = state.anthropic
    const auth = readAnthropicToken({ ompAuthFile, claudeCredentialsFile })
    if (!auth) { slot.error = 'no Anthropic OAuth token on this box'; return }
    try {
      const doc = await getJson('https://api.anthropic.com/api/oauth/usage', {
        Authorization: `Bearer ${auth.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      })
      slot.data = { windows: normalizeAnthropicUsage(doc), tokenSource: auth.source, tokenExpiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : null }
      slot.error = null
      slot.lastGoodAt = now()
      slot.retryAt = 0
      persist()
    } catch (error) {
      if (error.status === 429) {
        slot.retryAt = now() + (error.retryAfterMs || anthropicPollMs) + RETRY_AFTER_MARGIN_MS
        const next = `next try in ${minutesUntil(slot.retryAt)} min`
        slot.error = slot.data
          ? `Anthropic is rate-limiting its usage endpoint; showing the reading from ${new Date(slot.lastGoodAt).toLocaleString()} (${next})`
          : `Anthropic is rate-limiting its usage endpoint (${next})`
      } else {
        slot.error = error.status === 403 ? 'Anthropic token lacks the user:profile scope'
          : `Anthropic usage unavailable (${error.message})`
      }
    }
  }

  async function refreshOpenRouter() {
    const slot = state.openrouter
    const key = readOpenRouterKey({ keyvaultFile, env })
    if (!key) { slot.error = 'no OpenRouter key on this box'; return }
    try {
      const headers = { Authorization: `Bearer ${key}` }
      const [credits, keyInfo] = await Promise.all([
        getJson('https://openrouter.ai/api/v1/credits', headers),
        getJson('https://openrouter.ai/api/v1/auth/key', headers),
      ])
      const c = credits?.data || {}
      const k = keyInfo?.data || {}
      slot.data = {
        totalCredits: Number(c.total_credits) || 0,
        totalUsage: Number(c.total_usage) || 0,
        remaining: (Number(c.total_credits) || 0) - (Number(c.total_usage) || 0),
        usageDaily: Number(k.usage_daily) || 0,
        usageWeekly: Number(k.usage_weekly) || 0,
        usageMonthly: Number(k.usage_monthly) || 0,
        keyLimit: Number.isFinite(Number(k.limit)) && k.limit !== null ? Number(k.limit) : null,
        keyLimitRemaining: Number.isFinite(Number(k.limit_remaining)) && k.limit_remaining !== null ? Number(k.limit_remaining) : null,
      }
      slot.error = null
      slot.lastGoodAt = now()
    } catch (error) {
      slot.error = `OpenRouter unavailable (${error.message})`
    }
  }

  async function refreshBroker() {
    const slot = state.broker
    const token = brokerTokenFile ? readBrokerToken(brokerTokenFile) : null
    if (!brokerUrl || !token) { slot.error = null; return }
    try {
      const doc = await getJson(`${brokerUrl.replace(/\/$/, '')}/v1/usage`, { Authorization: `Bearer ${token}` })
      slot.data = normalizeBrokerReports(doc)
      slot.error = null
      slot.lastGoodAt = now()
    } catch (error) {
      slot.error = `OMP auth broker unavailable (${error.message})`
    }
  }

  async function refreshAnthropicApi() {
    const slot = state.anthropicApi
    const key = readKeyvaultKey('ANTHROPIC_ADMIN_KEY', { keyvaultFile, env })
    if (!key) { slot.data = null; slot.error = null; return }
    const end = new Date(now())
    end.setUTCHours(0, 0, 0, 0)
    end.setUTCDate(end.getUTCDate() + 1)
    const start = new Date(end.getTime() - 7 * 86_400_000)
    const url = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${start.toISOString()}&ending_at=${end.toISOString()}&bucket_width=1d&limit=7`
    try {
      const doc = await getJson(url, { 'x-api-key': key, 'anthropic-version': '2023-06-01' })
      slot.data = { days: normalizeAnthropicCostReport(doc) }
      slot.error = null
      slot.lastGoodAt = now()
    } catch (error) {
      slot.error = `Anthropic cost report unavailable (${error.message})`
    }
  }

  const inFlight = new Map()
  function refreshDue(name, refresh) {
    const slot = state[name]
    const interval = name === 'anthropic' || name === 'anthropicApi' ? anthropicPollMs : name === 'broker' ? Math.min(pollMs, 60_000) : pollMs
    if (now() - slot.fetchedAt < interval || now() < slot.retryAt) return inFlight.get(name) || Promise.resolve()
    slot.fetchedAt = now()
    const pending = refresh().finally(() => inFlight.delete(name))
    inFlight.set(name, pending)
    return pending
  }

  async function snapshot({ codexRateLimits = null } = {}) {
    await Promise.all([refreshDue('anthropic', refreshAnthropic), refreshDue('openrouter', refreshOpenRouter), refreshDue('broker', refreshBroker), refreshDue('anthropicApi', refreshAnthropicApi)])
    const broker = state.broker.data || {}
    const codexAuth = readCodexAuth({ ompAuthFile })
    const codexExpired = codexAuth?.expiresAt ? codexAuth.expiresAt < now() : null
    // Live broker reports beat transcript-derived and cached readings.
    const brokerCodex = broker['openai-codex']
    const brokerAnthropic = broker.anthropic
    if (brokerCodex) {
      return {
        anthropic: anthropicView(brokerAnthropic),
        openrouter: openrouterView(),
        anthropicApi: anthropicApiView(),
        codex: {
          windows: brokerCodex.windows,
          observedAt: brokerCodex.fetchedAt ? new Date(brokerCodex.fetchedAt).toISOString() : null,
          credits: null,
          tokenExpiresAt: codexAuth?.expiresAt ? new Date(codexAuth.expiresAt).toISOString() : null,
          tokenExpired: false,
          error: null,
          source: 'omp-auth-broker',
        },
      }
    }
    return {
      anthropic: anthropicView(brokerAnthropic),
      openrouter: openrouterView(),
      anthropicApi: anthropicApiView(),
      codex: {
        windows: normalizeCodexRateLimits(codexRateLimits),
        observedAt: codexRateLimits?.at ? new Date(codexRateLimits.at).toISOString() : null,
        credits: codexRateLimits?.credits && typeof codexRateLimits.credits === 'object'
          ? { hasCredits: Boolean(codexRateLimits.credits.has_credits), unlimited: Boolean(codexRateLimits.credits.unlimited), balance: String(codexRateLimits.credits.balance ?? '') }
          : null,
        tokenExpiresAt: codexAuth?.expiresAt ? new Date(codexAuth.expiresAt).toISOString() : null,
        tokenExpired: codexExpired,
        error: codexAuth ? (codexExpired ? 'Codex login expired; limits shown are from the last transcript that reported them' : null) : 'no Codex login on this box',
      },
    }
  }

  function anthropicView(fromBroker) {
    if (fromBroker) {
      return {
        windows: fromBroker.windows,
        tokenSource: 'omp-auth-broker',
        tokenExpiresAt: null,
        error: null,
        lastGoodAt: fromBroker.fetchedAt ? new Date(fromBroker.fetchedAt).toISOString() : null,
      }
    }
    return {
      ...state.anthropic.data,
      error: state.anthropic.error,
      lastGoodAt: state.anthropic.lastGoodAt ? new Date(state.anthropic.lastGoodAt).toISOString() : null,
    }
  }

  function anthropicApiView() {
    const slot = state.anthropicApi
    if (!slot.data && !slot.error) return null
    const days = slot.data?.days || []
    const today = new Date(now()).toISOString().slice(0, 10)
    return {
      days,
      todayUsd: days.find(d => d.date === today)?.usd ?? 0,
      weekUsd: Math.round(days.reduce((sum, d) => sum + d.usd, 0) * 100) / 100,
      error: slot.error,
      lastGoodAt: slot.lastGoodAt ? new Date(slot.lastGoodAt).toISOString() : null,
    }
  }

  function openrouterView() {
    return {
      ...state.openrouter.data,
      error: state.openrouter.error,
      lastGoodAt: state.openrouter.lastGoodAt ? new Date(state.openrouter.lastGoodAt).toISOString() : null,
    }
  }

  return { snapshot }
}
