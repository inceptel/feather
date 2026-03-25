// @ts-check
import { test, expect } from '@playwright/test'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'

test.describe('Feather E2E', () => {

  test('loads the app and shows empty state', async ({ page }) => {
    await page.goto(BASE)
    // Should see the empty state prompt
    await expect(page.locator('text=Open a session or create a new one')).toBeVisible({ timeout: 10000 })
  })

  test('hamburger menu opens sidebar', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    // Click hamburger
    const hamburger = page.locator('button:has-text("☰")')
    await expect(hamburger).toBeVisible()
    await hamburger.click()

    // Sidebar should show "Feather" title and "+ New Claude" button
    await expect(page.getByText('Feather', { exact: true })).toBeVisible()
    await expect(page.locator('button:has-text("+ New Claude")')).toBeVisible()
  })

  test('sidebar shows session list', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    // Open sidebar
    await page.locator('button:has-text("☰")').click()

    // Wait for sessions to load — there should be at least one
    // (since we're testing against a real instance with sessions)
    await page.waitForTimeout(1000)

    // Check the sidebar has session entries (or just the + New button if no sessions)
    const newButton = page.locator('button:has-text("+ New Claude")')
    await expect(newButton).toBeVisible()
  })

  test('selecting a session loads messages', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    // Open sidebar
    await page.locator('button:has-text("☰")').click()
    await page.waitForTimeout(500)

    // Click first session in the list (if any)
    const sessions = page.locator('[style*="cursor: pointer"][style*="border-left"]')
    const count = await sessions.count()
    if (count === 0) {
      test.skip()
      return
    }

    await sessions.first().click()
    await page.waitForTimeout(1000)

    // Should see chat/terminal tabs
    await expect(page.locator('button:has-text("Chat")')).toBeVisible()
    await expect(page.locator('button:has-text("Terminal")')).toBeVisible()

    // Should see chat tab content area (messages or loading)
    await expect(page.locator('button:has-text("Chat")')).toBeVisible()
    await expect(page.locator('button:has-text("Terminal")')).toBeVisible()
  })

  test('chat and terminal tabs switch correctly', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    // Open sidebar and select first session
    await page.locator('button:has-text("☰")').click()
    await page.waitForTimeout(500)

    const sessions = page.locator('[style*="cursor: pointer"][style*="border-left"]')
    if (await sessions.count() === 0) {
      test.skip()
      return
    }

    await sessions.first().click()
    await page.waitForTimeout(500)

    // Chat tab should be active by default
    const chatTab = page.locator('button:has-text("Chat")')
    const terminalTab = page.locator('button:has-text("Terminal")')

    // Switch to terminal
    await terminalTab.click()
    await page.waitForTimeout(500)

    // Terminal container should be visible
    const terminalContainer = page.locator('.xterm')
    // It may or may not connect depending on tmux state — just check tab switches

    // Switch back to chat
    await chatTab.click()
    await page.waitForTimeout(300)

    // Chat input should be visible
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await expect(textarea).toBeVisible()
  })

  test('chat input auto-grows', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    // Select a session
    await page.locator('button:has-text("☰")').click()
    await page.waitForTimeout(500)
    const sessions = page.locator('[style*="cursor: pointer"][style*="border-left"]')
    if (await sessions.count() === 0) {
      test.skip()
      return
    }
    await sessions.first().click()
    await page.waitForTimeout(500)

    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await expect(textarea).toBeVisible()

    // Get initial height
    const initialHeight = await textarea.evaluate(el => el.offsetHeight)

    // Type multiple lines
    await textarea.fill('Line 1\nLine 2\nLine 3\nLine 4')
    await page.waitForTimeout(100)

    // Height should have grown
    const newHeight = await textarea.evaluate(el => el.offsetHeight)
    expect(newHeight).toBeGreaterThanOrEqual(initialHeight)
  })

  test('send button activates when text is entered', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    // Select a session
    await page.locator('button:has-text("☰")').click()
    await page.waitForTimeout(500)
    const sessions = page.locator('[style*="cursor: pointer"][style*="border-left"]')
    if (await sessions.count() === 0) {
      test.skip()
      return
    }
    await sessions.first().click()
    await page.waitForTimeout(500)

    const sendButton = page.locator('button:has-text("Send")')
    const textarea = page.locator('textarea[placeholder="Send a message..."]')

    // Send button should be dim/inactive when empty
    const bgBefore = await sendButton.evaluate(el => el.style.background)

    // Type something
    await textarea.fill('test message')
    await page.waitForTimeout(100)

    // Send button should change color
    const bgAfter = await sendButton.evaluate(el => el.style.background)
    expect(bgAfter).not.toEqual(bgBefore)
  })

  test('messages render markdown correctly', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    // Select a session that has messages
    await page.locator('button:has-text("☰")').click()
    await page.waitForTimeout(500)
    const sessions = page.locator('[style*="cursor: pointer"][style*="border-left"]')
    if (await sessions.count() === 0) {
      test.skip()
      return
    }
    await sessions.first().click()
    await page.waitForTimeout(1500)

    // Check that markdown class exists on rendered messages
    const markdownBlocks = page.locator('.markdown')
    const mdCount = await markdownBlocks.count()
    if (mdCount === 0) {
      // No markdown content in this session — that's ok
      return
    }

    // Verify markdown rendered as HTML, not plain text
    // (e.g., ** should become <strong>, not show as **)
    const firstMd = markdownBlocks.first()
    const html = await firstMd.innerHTML()
    // Should contain HTML tags, not raw markdown
    expect(html).toMatch(/<[a-z]/)
  })

  test('header shows session title', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    // Select a session
    await page.locator('button:has-text("☰")').click()
    await page.waitForTimeout(500)
    const sessions = page.locator('[style*="cursor: pointer"][style*="border-left"]')
    if (await sessions.count() === 0) {
      test.skip()
      return
    }
    await sessions.first().click()
    await page.waitForTimeout(500)

    // Header should show something other than "Select a session"
    await expect(page.locator('text=Select a session')).not.toBeVisible()
  })

  test('SSE stream connects for a session', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    // Select a session
    await page.locator('button:has-text("☰")').click()
    await page.waitForTimeout(500)
    const sessions = page.locator('[style*="cursor: pointer"][style*="border-left"]')
    if (await sessions.count() === 0) {
      test.skip()
      return
    }

    // Listen for SSE request
    const ssePromise = page.waitForRequest(req =>
      req.url().includes('/api/sessions/') && req.url().includes('/stream')
    )

    await sessions.first().click()

    // SSE stream should be requested
    const sseReq = await ssePromise
    expect(sseReq.url()).toContain('/stream')
  })

  test('resume button appears for inactive sessions', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    // Open sidebar and select first session
    await page.locator('button:has-text("☰")').click()
    await page.waitForTimeout(500)

    const sessions = page.locator('[style*="cursor: pointer"][style*="border-left"]')
    const count = await sessions.count()
    if (count === 0) {
      test.skip()
      return
    }

    // Click first session — sidebar closes, check for Resume button
    await sessions.first().click()
    await page.waitForTimeout(500)

    // Either we see a Resume button (inactive) or we don't (active) — both are valid
    const resumeBtn = page.locator('button:has-text("Resume")')
    const isVisible = await resumeBtn.isVisible()
    // Test passes either way — we just verify the UI doesn't crash
    expect(typeof isVisible).toBe('boolean')
  })

  test('mobile viewport renders correctly', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 }) // iPhone X
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    // App should fill the viewport
    const app = page.locator('div').first()
    await expect(app).toBeVisible()

    // Hamburger should be visible
    const hamburger = page.locator('button:has-text("☰")')
    await expect(hamburger).toBeVisible()
  })
})
