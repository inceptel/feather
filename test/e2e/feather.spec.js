// @ts-check
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'

const BASE = process.env.FEATHER_URL || 'http://localhost:4870'
const HOME = process.env.HOME || '/home/user'
const CLAUDE_PROJECTS = path.join(HOME, '.claude/projects')

// ── Synthetic session setup ─────────────────────────────────────────────────

const TEST_SESSION_ID = `e2e-feather-${Date.now()}`
let testSessionPath

function writeLine(obj) {
  fs.appendFileSync(testSessionPath, JSON.stringify(obj) + '\n')
}

test.beforeAll(() => {
  const dirs = fs.readdirSync(CLAUDE_PROJECTS).filter(d =>
    fs.statSync(path.join(CLAUDE_PROJECTS, d)).isDirectory()
  )
  if (dirs.length === 0) throw new Error('No project dirs in ~/.claude/projects/')

  testSessionPath = path.join(CLAUDE_PROJECTS, dirs[0], `${TEST_SESSION_ID}.jsonl`)

  writeLine({
    type: 'user', uuid: 'e2e-msg-001', timestamp: '2025-06-15T14:00:00Z',
    isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'Explain how **markdown** rendering works in `Feather`' },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-002', timestamp: '2025-06-15T14:00:05Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '**Planning** the markdown pipeline.' },
        { type: 'text', text: 'Feather uses **marked** with GFM support.\n\n## How it works\n\n1. Raw text goes through `marked.parse()`\n2. Output is sanitized with `DOMPurify`\n3. Result is cached in an LRU map\n\n```js\nconst html = marked.parse(text)\nconst safe = DOMPurify.sanitize(html)\n```\n\nThis keeps things **fast** and **secure**.' },
      ],
    },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-003', timestamp: '2025-06-15T14:00:10Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool_e2e', name: 'Read', input: { file_path: '/src/MessageView.tsx' } },
        { type: 'tool_use', id: 'tool_err', name: 'Read', input: { file_path: '/missing.txt' } },
      ],
    },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-004', timestamp: '2025-06-15T14:00:12Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: 'tool_e2e', content: 'export function MessageView() { ... }', is_error: false }],
    },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-005', timestamp: '2025-06-15T14:00:15Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: 'tool_err', content: 'ENOENT: no such file', is_error: true }],
    },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-005-final', timestamp: '2025-06-15T14:00:20Z',
    isSidechain: false, isMeta: false,
    message: { role: 'assistant', content: 'Tool work complete.' },
  })
  writeLine({
    type: 'user', uuid: 'e2e-msg-006', timestamp: '2025-06-15T14:01:00Z',
    isSidechain: false, isMeta: false,
    message: { role: 'user', content: 'Thanks, that makes sense!' },
  })
  writeLine({
    type: 'assistant', uuid: 'e2e-msg-007', timestamp: '2025-06-15T14:01:05Z',
    isSidechain: false, isMeta: false,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `[Open local session file](${testSessionPath})` }],
    },
  })
})

test.afterAll(() => {
  try { fs.unlinkSync(testSessionPath) } catch {}
})

// ── Helpers ─────────────────────────────────────────────────────────────────

async function openSidebar(page) {
  await page.locator('button:has-text("☰")').click()
  await page.waitForTimeout(300)
}

async function selectTestSession(page) {
  await openSidebar(page)
  // Find and click our test session by title text
  const sessionItem = page.locator(`text=Explain how`).first()
  await expect(sessionItem).toBeVisible({ timeout: 5000 })
  await sessionItem.click()
  await page.waitForTimeout(500)
}

// ── App shell ───────────────────────────────────────────────────────────────

test.describe('App shell', () => {
  test('shows empty state when no session selected', async ({ page }) => {
    await page.goto(BASE)
    await expect(page.getByText('Rooms', { exact: true })).toBeVisible({ timeout: 10000 })
    // No tabs should be visible
    await expect(page.locator('button:has-text("Chat")')).not.toBeVisible()
    await expect(page.locator('button:has-text("Terminal")')).not.toBeVisible()
  })

  test('hamburger opens sidebar with Feather title and New button', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openSidebar(page)
    await expect(page.getByText('Feather', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '+ New Session', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Auto', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'CoS', exact: true })).toHaveCount(0)
  })

  test('sidebar closes when X is clicked', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openSidebar(page)
    await expect(page.getByText('Feather', { exact: true })).toBeVisible()
    // Click close button
    await page.locator('button:has-text("×")').click()
    await page.waitForTimeout(300)
    // Closed state restores the hamburger control.
    await expect(page.locator('button:has-text("☰")')).toBeVisible()
  })

  test('sidebar shows our test session', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openSidebar(page)
    await expect(page.locator(`text=Explain how`).first()).toBeVisible({ timeout: 5000 })
  })
})

// ── Session selection ───────────────────────────────────────────────────────

test.describe('Session selection', () => {
  test('selecting a session shows chat and terminal tabs', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
    await expect(page.locator('button:has-text("Chat")')).toBeVisible()
    await expect(page.locator('button:has-text("Terminal")')).toBeVisible()
  })

  test('selecting a session hides the empty state', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
    await expect(page.locator('text=Open a session or create a new one')).not.toBeVisible()
  })

  test('header shows session title after selection', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
    await expect(page.locator('text=Select a session')).not.toBeVisible()
  })

  test('SSE stream is established when session is selected', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')

    const ssePromise = page.waitForRequest(req =>
      req.url().includes('/api/sessions/') && req.url().includes('/stream')
    )
    await selectTestSession(page)
    const sseReq = await ssePromise
    expect(sseReq.url()).toContain('/stream')
  })
})

// ── Message rendering ───────────────────────────────────────────────────────

test.describe('Message rendering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
    // Wait for messages to load
    await expect(page.locator('.markdown').first()).toBeVisible({ timeout: 5000 })
  })

  test('user message renders as right-aligned bubble', async ({ page }) => {
    // User messages should have flex-end alignment
    const userBubbles = page.locator('div[style*="flex-end"]')
    await expect(userBubbles.first()).toBeVisible()
  })

  test('assistant message renders as left-aligned bubble', async ({ page }) => {
    const assistantBubbles = page.locator('div[style*="flex-start"]')
    await expect(assistantBubbles.first()).toBeVisible()
  })

  test('markdown bold renders as <strong>', async ({ page }) => {
    // The assistant message contains **marked** and **fast** and **secure**
    const strongElements = page.locator('.markdown strong')
    const count = await strongElements.count()
    expect(count).toBeGreaterThanOrEqual(1)
    // Check specific text
    const allText = await page.locator('.markdown').allInnerTexts()
    const combined = allText.join(' ')
    expect(combined).toContain('marked')
    expect(combined).toContain('fast')
    expect(combined).toContain('secure')
  })

  test('markdown inline code renders as <code>', async ({ page }) => {
    const codeElements = page.locator('.markdown code')
    const count = await codeElements.count()
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test('markdown heading renders as <h2>', async ({ page }) => {
    const h2 = page.locator('.markdown h2')
    await expect(h2.first()).toBeVisible()
    const text = await h2.first().innerText()
    expect(text).toContain('How it works')
  })

  test('markdown ordered list renders as <ol>', async ({ page }) => {
    const ol = page.locator('.markdown ol')
    await expect(ol.first()).toBeVisible()
    const items = page.locator('.markdown ol li')
    const count = await items.count()
    expect(count).toBe(3)
  })

  test('markdown code block renders as <pre><code>', async ({ page }) => {
    const pre = page.locator('.markdown pre')
    await expect(pre.first()).toBeVisible()
    const code = await pre.first().innerText()
    expect(code).toContain('marked.parse')
    expect(code).toContain('DOMPurify.sanitize')
  })

  test('markdown absolute filesystem link opens Feather file viewer', async ({ page }) => {
    const chatUrl = page.url()
    await page.getByRole('link', { name: 'Open local session file' }).click()
    await expect(page.getByTitle(testSessionPath)).toBeVisible()
    expect(page.url()).toBe(chatUrl)
  })

  test('assistant reasoning is folded into quiet Details while the final answer stays visible', async ({ page }) => {
    await expect(page.getByText(/Feather uses .*marked.* with GFM support/)).toBeVisible()
    const details = page.getByTestId('work-log-summary').first()
    await expect(details).toBeVisible()
    await expect(details).toContainText('Details')
    await expect(details).not.toContainText('execution step')
    await expect(page.getByText('Planning the markdown pipeline.')).not.toBeVisible()

    await details.click()
    const workLogDetail = page.getByTestId('work-log-detail').first()
    await expect(workLogDetail).toContainText('1 execution step')
    await expect(workLogDetail).toContainText('Planning the markdown pipeline.')
    await expect(workLogDetail.locator('strong')).toHaveText('Planning')
    await expect(workLogDetail).not.toContainText('**Planning**')
    await expect(workLogDetail).not.toContainText('Reasoning')
  })

  test('Details precedes the final answer in chronological turn order', async ({ page }) => {
    const bubble = page.locator('.asst-bubble').filter({ hasText: 'Feather uses marked with GFM support.' }).first()
    const chronological = await bubble.evaluate(element => {
      const details = element.querySelector('.work-log')
      const answer = [...element.querySelectorAll('.markdown')].find(node => node.textContent?.includes('Feather uses marked with GFM support.'))
      return !!(details && answer && (details.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING))
    })
    expect(chronological).toBe(true)
  })

  test('tool_use block is preserved inside Details', async ({ page }) => {
    const toolBubble = page.locator('.asst-bubble').filter({ hasText: 'Tool work complete.' })
    await toolBubble.getByTestId('work-log-summary').click()
    await expect(toolBubble.getByText('Read').first()).toBeVisible()
  })

  test('tool_result output is revealed from Details and the tool call', async ({ page }) => {
    const toolBubble = page.locator('.asst-bubble').filter({ hasText: 'Tool work complete.' })
    await toolBubble.getByTestId('work-log-summary').click()
    const summary = toolBubble.locator('summary', { hasText: 'MessageView.tsx' })
    await expect(summary).toBeVisible()
    await summary.click()
    await expect(toolBubble.getByText('export function MessageView')).toBeVisible()
  })

  test('failed work error remains reachable inside Details', async ({ page }) => {
    const toolBubble = page.locator('.asst-bubble').filter({ hasText: 'Tool work complete.' })
    const workLog = toolBubble.getByTestId('work-log-summary')
    await expect(workLog).toHaveText(/Details/)
    await workLog.click()
    const summary = toolBubble.locator('summary', { hasText: 'missing.txt' })
    await expect(summary).toBeVisible()
    await summary.click()
    await expect(toolBubble.getByText('ENOENT: no such file')).toBeVisible()
  })

  test('timestamps are displayed on messages', async ({ page }) => {
    // Timestamps are small text under each bubble — look for time patterns
    const allText = await page.locator('span').allInnerTexts()
    const timePattern = /\d{1,2}:\d{2}/
    const timestamps = allText.filter(t => timePattern.test(t))
    expect(timestamps.length).toBeGreaterThanOrEqual(4)
  })
})

// ── Chat input ──────────────────────────────────────────────────────────────

test.describe('Chat input', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
  })

  test('chat input is visible on chat tab', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await expect(textarea).toBeVisible()
  })

  test('chat input is hidden on terminal tab', async ({ page }) => {
    await page.locator('button:has-text("Terminal")').click()
    await page.waitForTimeout(300)
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await expect(textarea).not.toBeVisible()
  })

  test('send button is dim when input is empty', async ({ page }) => {
    const sendBtn = page.locator('button:has-text("Send")')
    const bg = await sendBtn.evaluate(el => getComputedStyle(el).backgroundColor)
    // Should be gray-ish (not green)
    expect(bg).not.toContain('74, 186, 106')
  })

  test('send button changes style when text is entered', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    const sendBtn = page.locator('button:has-text("Send")')

    // Get computed background when empty
    const bgEmpty = await sendBtn.evaluate(el => getComputedStyle(el).backgroundColor)

    await textarea.fill('test')
    await page.waitForTimeout(100)

    // Get computed background with text — should be different (green vs gray)
    const bgFilled = await sendBtn.evaluate(el => getComputedStyle(el).backgroundColor)
    expect(bgFilled).not.toEqual(bgEmpty)
  })

  test('textarea auto-grows with multi-line input', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    const initialHeight = await textarea.evaluate(el => el.offsetHeight)

    await textarea.fill('Line 1\nLine 2\nLine 3\nLine 4\nLine 5')
    // Trigger the input event that drives auto-grow
    await textarea.dispatchEvent('input')
    await page.waitForTimeout(200)

    const newHeight = await textarea.evaluate(el => el.offsetHeight)
    expect(newHeight).toBeGreaterThan(initialHeight)
  })

  test('input clears after sending', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await textarea.fill('test message to clear')
    await page.waitForTimeout(100)

    // Send
    await page.locator('button:has-text("Send")').click()
    await page.waitForTimeout(300)

    const value = await textarea.inputValue()
    expect(value).toBe('')
  })

  test('Enter key sends, Shift+Enter adds newline', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder="Send a message..."]')

    // Shift+Enter should not send
    await textarea.fill('line 1')
    await textarea.press('Shift+Enter')
    await page.waitForTimeout(100)
    // Should still have text
    const val = await textarea.inputValue()
    expect(val.length).toBeGreaterThan(0)

    // Enter should send and clear
    await textarea.fill('will be sent')
    await textarea.press('Enter')
    await page.waitForTimeout(300)
    const afterSend = await textarea.inputValue()
    expect(afterSend).toBe('')
  })
})

// ── Tab switching ───────────────────────────────────────────────────────────

test.describe('Tab switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
  })

  test('chat tab is active by default', async ({ page }) => {
    const chatTab = page.locator('button:has-text("Chat")')
    // Active tab should have a non-transparent bottom border
    const borderBottom = await chatTab.evaluate(el => {
      const cs = getComputedStyle(el)
      return cs.borderBottomColor
    })
    // Should NOT be transparent
    expect(borderBottom).not.toBe('rgba(0, 0, 0, 0)')
    expect(borderBottom).not.toBe('transparent')
  })

  test('clicking terminal tab hides chat content', async ({ page }) => {
    await page.locator('button:has-text("Terminal")').click()
    await page.waitForTimeout(500)

    // Chat input should be hidden
    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await expect(textarea).not.toBeVisible()
  })

  test('switching back to chat shows messages again', async ({ page }) => {
    // Go to terminal
    await page.locator('button:has-text("Terminal")').click()
    await page.waitForTimeout(300)

    // Back to chat
    await page.locator('button:has-text("Chat")').click()
    await page.waitForTimeout(300)

    // Messages should be visible
    await expect(page.locator('.markdown').first()).toBeVisible()
  })

  test('prompts tab lists only the user inputs, hiding assistant turns and composer', async ({ page }) => {
    await page.locator('button:has-text("Prompts")').click()
    await page.waitForTimeout(400)
    const panel = page.getByTestId('prompts-panel')
    await expect(panel).toBeVisible()
    // Both user prompts appear (rendered as raw text, markdown not parsed).
    await expect(panel.getByText('Thanks, that makes sense!')).toBeVisible()
    await expect(panel.getByText(/rendering works in .*Feather/)).toBeVisible()
    // Assistant/tool content is not part of the prompts feed.
    await expect(panel.getByText(/marked/)).toHaveCount(0)
    // The composer is hidden while viewing prompts.
    await expect(page.locator('textarea[placeholder="Send a message..."]')).not.toBeVisible()
  })

})

// ── Live SSE updates in the browser ─────────────────────────────────────────

test.describe('Live updates', () => {
  test('new message appears in real-time via SSE', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
    await expect(page.locator('.markdown').first()).toBeVisible({ timeout: 5000 })

    // Count current messages
    const beforeCount = await page.locator('.msg-row').count()

    // Write a new message to the JSONL file
    const liveUuid = `e2e-live-${Date.now()}`
    writeLine({
      type: 'user', uuid: liveUuid, timestamp: '2025-06-15T14:05:00Z',
      isSidechain: false, isMeta: false,
      message: { role: 'user', content: 'This message arrived via SSE live update!' },
    })

    // Wait for it to appear in the chat (a user message now also renders in the
    // hidden Prompts panel, so scope to the chat markdown paragraph).
    await expect(page.getByRole('paragraph').filter({ hasText: 'This message arrived via SSE live update!' })).toBeVisible({ timeout: 10000 })

    // Should have one more message
    const afterCount = await page.locator('.msg-row').count()
    expect(afterCount).toBeGreaterThan(beforeCount)
  })

  test('native OMP tool intent replaces live status and a final answer clears it', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)

    writeLine({
      type: 'assistant', uuid: `e2e-status-1-${Date.now()}`, timestamp: '2025-06-15T14:06:00Z',
      isSidechain: false, isMeta: false,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'status-tool-1', name: 'read', input: { file_path: '/tmp/upload' }, intent: 'Inspecting upload recovery.' }],
      },
    })
    const status = page.getByRole('status').filter({ hasText: 'Inspecting upload recovery.' })
    await expect(status).toBeVisible({ timeout: 10000 })
    const liveWork = page.getByTestId('live-work-turn')
    await expect(liveWork).toBeVisible()
    await expect(liveWork.getByTestId('work-log-summary')).toContainText('Details')

    writeLine({
      type: 'assistant', uuid: `e2e-status-2-${Date.now()}`, timestamp: '2025-06-15T14:06:05Z',
      isSidechain: false, isMeta: false,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'status-tool-2', name: 'bash', input: { command: 'npm test' }, intent: 'Testing the repaired upload.' }],
      },
    })
    const currentStatus = page.getByRole('status').filter({ hasText: 'Testing the repaired upload.' })
    await expect(currentStatus).toBeVisible({ timeout: 10000 })
    await expect(currentStatus.locator('summary')).toContainText('Testing the repaired upload.')
    await expect(currentStatus.locator('summary')).not.toContainText('Inspecting upload recovery.')

    writeLine({
      type: 'assistant', uuid: `e2e-status-final-${Date.now()}`, timestamp: '2025-06-15T14:06:10Z',
      isSidechain: false, isMeta: false,
      message: { role: 'assistant', content: 'Status lifecycle complete.' },
    })
    await expect(page.getByText('Status lifecycle complete.')).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole('status').filter({ hasText: 'Testing the repaired upload.' })).not.toBeVisible()
    await expect(liveWork).toHaveCount(0)
    const finalBubble = page.locator('.asst-bubble').filter({ hasText: 'Status lifecycle complete.' })
    await expect(finalBubble.getByTestId('work-log-summary')).toBeVisible()
  })
})

// ── Mobile viewport ─────────────────────────────────────────────────────────

test.describe('Mobile viewport', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('hamburger is visible on mobile', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await expect(page.locator('button:has-text("☰")')).toBeVisible()
  })

  test('sidebar opens and fills screen on mobile', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await openSidebar(page)
    await expect(page.getByRole('button', { name: '+ New Session', exact: true })).toBeVisible()
  })

  test('messages are readable on mobile', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)
    await expect(page.locator('.markdown').first()).toBeVisible({ timeout: 5000 })

    // Check text is visible (not invisible due to color issues)
    const firstMd = page.locator('.markdown').first()
    const color = await firstMd.evaluate(el => getComputedStyle(el).color)
    // Should not be transparent or same as background
    expect(color).not.toBe('rgba(0, 0, 0, 0)')
  })

  test('chat input works on mobile', async ({ page }) => {
    await page.goto(BASE)
    await page.waitForLoadState('networkidle')
    await selectTestSession(page)

    const textarea = page.locator('textarea[placeholder="Send a message..."]')
    await expect(textarea).toBeVisible()
    await textarea.fill('mobile test')
    await expect(page.locator('button:has-text("Send")')).toBeVisible()
  })
})
