// @ts-check
import { test, expect } from '@playwright/test'

// Clearing the file input after a pick empties its live FileList (Safari and
// Chromium alike). Choosing several photos must still attach all of them;
// WebKit is the iPhone's engine, where this was reported.
test.use({ browserName: 'webkit', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const ID = 'photo-picker-chat'
// 1x1 PNG so WebKit really decodes and resizes each image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('picking several photos uploads and sends every one of them', async ({ page }) => {
  const uploaded = []
  let sentText = null
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    const p = url.pathname
    if (p === `/api/sessions/${ID}/stream`) {
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: connected\ndata: {}\n\n' })
    }
    if (p === '/api/upload') {
      const name = decodeURIComponent(route.request().headers()['x-filename'] || '')
      uploaded.push(name)
      return route.fulfill({ json: { path: `/tmp/uploads/${name}` } })
    }
    if (p === `/api/sessions/${ID}/send`) {
      sentText = JSON.parse(route.request().postData() || '{}').text
      return route.fulfill({ json: { ok: true, sentAt: new Date().toISOString() } })
    }
    const body = p === '/api/sessions' ? { sessions: [{ id: ID, title: 'Photos', updatedAt: new Date().toISOString(), isActive: false, agent: 'claude' }] }
      : p === `/api/sessions/${ID}/messages` ? { messages: [], hasMore: false, cursor: 0, nextBefore: null }
      : p === '/api/chat-pins' ? { pins: [], archived: [] }
      : p === '/api/rooms' ? { rooms: [] }
      : p === '/api/boxes' ? { boxes: [] }
      : p === '/api/sidecar' ? { groups: [] }
      : p === '/api/sharing/peers' ? { peers: [] }
      : p === '/api/agents' ? { agents: [] }
      : p.endsWith('/protocol-runs') || p.endsWith('/btw') ? []
      : ['/api/quick-links', '/api/starred'].includes(p) ? [] : {}
    await route.fulfill({ json: body })
  })
  await page.goto(`/#${ID}`)
  await expect(page.locator('textarea')).toBeVisible()
  const names = ['one.png', 'two.png', 'three.png']
  await page.locator('input[type=file]').setInputFiles(names.map(name => ({ name, mimeType: 'image/png', buffer: PNG })))
  for (const name of names) await expect(page.getByRole('button', { name: `Remove ${name}`, exact: true })).toBeVisible()
  await expect(page.locator('img[src^="blob:"]')).toHaveCount(3)

  await page.locator('button[title="Send"]').last().click()
  await expect.poll(() => sentText).not.toBeNull()
  expect([...uploaded].sort()).toEqual([...names].sort())
  for (const name of names) expect(sentText).toContain(`/tmp/uploads/${name}`)
})
