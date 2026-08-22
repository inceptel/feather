// @ts-check
// Regression: assistant messages that embed Markdown images pointing at local
// filesystem paths (e.g. ![chart](/home/user/rooms/family/chart.png)) must
// render through /api/file instead of a broken <img src="/home/...">.
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HOME = process.env.HOME || '/home/user'
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const imagePath = path.resolve(__dirname, '../fixtures/tool-preview.svg')
const sessionId = `e2e-md-local-image-${Date.now()}`
let sessionPath

test.beforeAll(() => {
  const projectDir = fs.readdirSync(CLAUDE_PROJECTS)
    .map(name => path.join(CLAUDE_PROJECTS, name))
    .find(candidate => fs.statSync(candidate).isDirectory())
  if (!projectDir) throw new Error('No Claude project directory found')

  sessionPath = path.join(projectDir, `${sessionId}.jsonl`)
  const text = [
    `![Feeding chart](${imagePath})`,
    '',
    'My read: intake stabilized over the latest day.',
    '',
    `Missing one: ![gone](/no/such/dir/missing-image.png)`,
    '',
    `Full chart: [open the PNG](${imagePath})`,
    '',
    'Quoted marker, not an attachment: `[Attached image: /abs/path]` stays inline code.',
  ].join('\n')
  const lines = [
    {
      type: 'user', uuid: 'md-img-user', timestamp: '2026-08-22T12:00:00Z',
      isSidechain: false, isMeta: false,
      message: { role: 'user', content: 'chart please' },
    },
    {
      type: 'assistant', uuid: 'md-img-answer', timestamp: '2026-08-22T12:00:01Z',
      isSidechain: false, isMeta: false,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  ]
  fs.writeFileSync(sessionPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
})

test.afterAll(() => {
  try { fs.unlinkSync(sessionPath) } catch {}
})

test('local Markdown image renders via /api/file and opens the lightbox', async ({ page }) => {
  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })

  const img = page.locator('.markdown img.md-local-img[alt="Feeding chart"]')
  await expect(img).toBeVisible()
  await expect(img).toHaveAttribute('src', /^\/api\/file\?path=/)
  // The image actually loaded (not the broken-image placeholder)
  await expect.poll(() => img.evaluate(el => /** @type {HTMLImageElement} */ (el).naturalWidth)).toBeGreaterThan(0)

  await img.click()
  const lightbox = page.locator('div[style*="position: fixed"]').filter({
    has: page.locator('img[src*="tool-preview.svg"]'),
  })
  await expect(lightbox).toBeVisible()
})

test('missing local image degrades to a clickable path link', async ({ page }) => {
  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })

  const fallback = page.locator('.markdown a.feather-path', { hasText: '/no/such/dir/missing-image.png' })
  await expect(fallback).toBeVisible()
})

test('attachment markers quoted in code spans do not become previews', async ({ page }) => {
  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })

  // The quoted marker renders as literal inline code...
  const code = page.locator('.markdown code', { hasText: '[Attached image: /abs/path]' })
  await expect(code).toBeVisible()
  // ...and no attachment preview is hoisted for it.
  await expect(page.locator('img[src*="%2Fabs%2Fpath"]')).toHaveCount(0)
})

test('local Markdown link is wired to the Feather file viewer', async ({ page }) => {
  await page.goto(`/#${sessionId}`, { waitUntil: 'domcontentloaded' })

  const link = page.locator('.markdown a.feather-path', { hasText: 'open the PNG' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('data-path', imagePath)
})
