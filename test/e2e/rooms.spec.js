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
    isActive: false, agent: 'codex', projectId: '-srv-legacy-user-unrelated',
  }

  await page.route('**/api/rooms', async (route) => {
    await route.fulfill({ json: { rooms: [{
      name: 'marriage', cwd: '/srv/legacy-user/home/rooms/marriage', active: false,
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
  await page.locator('button:has-text("›")').click()
  await page.getByTestId('attach-existing-marriage').click()
  await expect(page.getByTestId('attach-picker-marriage')).toBeVisible()
  await page.getByTestId(`attach-${candidate.id}`).click()

  await expect(page.getByText(candidate.title, { exact: true })).toHaveCount(1)
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

test('Room card opens its main human chat instead of the Keep-working pulse', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const pulse = {
    id: 'pulse-chat', title: 'Keep working: #feather', updatedAt: '2026-08-24T01:00:00Z',
    isActive: true, agent: 'omp', roomAssigned: true,
  }
  const main = {
    id: 'main-human-chat', title: '#feather main', updatedAt: '2026-08-23T23:00:00Z',
    isActive: false, agent: 'omp', roomAssigned: true,
  }
  await page.route('**/api/rooms', route => route.fulfill({ json: { rooms: [{
    name: 'feather', cwd: '/home/user/rooms/feather', active: true,
    latest: { role: 'assistant', text: 'Pulse finished work.' }, updatedAt: pulse.updatedAt,
    updates: { count: 0, latestAt: null, latest: null },
    friction: { count: 0, latestAt: null, latest: null },
    pulse: { enabled: true, status: 'working', lastRunAt: pulse.updatedAt, nextRunAt: null, sessionId: pulse.id },
    sessions: [pulse, main],
  }] } }))

  await page.goto(BASE)
  await expect(page.getByText('#feather', { exact: true })).toBeVisible()
  await page.locator('button:has-text("›")').click()
  await expect(page.getByText('Main', { exact: true })).toBeVisible()
  await page.getByText('#feather', { exact: true }).click()
  await expect(page).toHaveURL(/#main-human-chat$/)
})

test('surfaces an unread Updates badge, opens the feed, and marks it read per-device', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const updates = [
    { id: 'u1', ts: '2026-08-22T12:00:00Z', text: 'First briefing. Why it matters: the herd is gone.' },
    { id: 'u2', ts: '2026-08-22T13:30:00Z', text: 'Second briefing.\nA new paragraph that must keep its line break.' },
  ]
  await page.route('**/api/rooms', async (route) => {
    await route.fulfill({ json: { rooms: [{
      name: 'meta', cwd: '/srv/rooms/meta', active: false, latest: null, updatedAt: updates[1].ts,
      updates: { count: updates.length, latestAt: updates[1].ts, latest: 'Second briefing. A new paragraph that must keep its line break.' },
      friction: { count: 0, latestAt: null, latest: null },
      pulse: { enabled: true, status: 'waiting', lastRunAt: null, nextRunAt: '2026-08-22T13:45:00Z', sessionId: null },
      sessions: [],
    }] } })
  })
  await page.route('**/api/rooms/meta/updates', async (route) => {
    await route.fulfill({ json: { updates } })
  })
  // Start from a clean per-device seen state so the badge shows unread.
  await page.addInitScript(() => { try { localStorage.removeItem('feather:roomUpdatesSeen') } catch {} })

  await page.goto(BASE)
  const pill = page.getByTestId('updates-meta')
  await expect(pill).toBeVisible()
  await expect(pill).toContainText('2 new')

  await pill.click()
  const panel = page.getByTestId('updates-panel-meta')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('First briefing. Why it matters: the herd is gone.')
  await expect(panel).toContainText('A new paragraph that must keep its line break.')

  // Opening the feed marks it read: the badge drops to the plain count.
  await expect(pill).not.toContainText('new')
  await expect(pill).toContainText('2')

  // Unread is remembered per-device (localStorage), not server-side.
  const seen = await page.evaluate(() => localStorage.getItem('feather:roomUpdatesSeen'))
  expect(JSON.parse(seen)).toMatchObject({ meta: 2 })
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
