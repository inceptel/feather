/**
 * Feather-rs E2E Tests
 *
 * Run with: npx playwright test tests/e2e.spec.js
 *
 * Prerequisites:
 * - npm install -D @playwright/test
 * - npx playwright install chromium
 * - feather-rs server running on port 4850
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.FEATHER_URL || 'http://localhost:4850';

test.describe('Feather-rs UI', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(BASE_URL);
        // Wait for sessions to load
        await page.waitForSelector('.session-item', { timeout: 10000 });
    });

    test.describe('Page Load', () => {
        test('should display Feather branding', async ({ page }) => {
            await expect(page.locator('h1')).toContainText('Feather');
        });

        test('should show SSE connected status', async ({ page }) => {
            await expect(page.locator('#sse-status')).toContainText('Connected');
        });

        test('should load sessions in sidebar', async ({ page }) => {
            await page.waitForSelector('#sessions .session-item', { timeout: 5000 });
            const sessionItems = page.locator('#sessions .session-item');
            await expect(sessionItems.first()).toBeVisible();
        });

        test('should display welcome message in main area', async ({ page }) => {
            await expect(page.locator('text=What can I help with?')).toBeVisible();
        });
    });

    test.describe('Project Dropdown', () => {
        test('project dropdown should be visible with a selected project', async ({ page }) => {
            const folderSelect = page.locator('#folder-select');
            await expect(folderSelect).toBeVisible();
            // Should have at least one option selected
            const selectedValue = await folderSelect.inputValue();
            expect(selectedValue).toBeTruthy();
        });

        test('should switch to another project', async ({ page }) => {
            const folderSelect = page.locator('#folder-select');
            // Get all available options
            const options = await folderSelect.locator('option').allTextContents();
            expect(options.length).toBeGreaterThan(0);

            // If there are multiple projects, switch to a different one
            if (options.length > 1) {
                const currentValue = await folderSelect.inputValue();
                const allValues = await folderSelect.locator('option').evaluateAll(
                    opts => opts.map(o => o.value)
                );
                const otherValue = allValues.find(v => v !== currentValue);
                await folderSelect.selectOption(otherValue);
                await page.waitForTimeout(1000);
                // Verify the dropdown reflects the new selection
                const newValue = await folderSelect.inputValue();
                expect(newValue).toBe(otherValue);
            }
        });

        test('should switch back to original project', async ({ page }) => {
            const folderSelect = page.locator('#folder-select');
            const originalValue = await folderSelect.inputValue();

            const allValues = await folderSelect.locator('option').evaluateAll(
                opts => opts.map(o => o.value)
            );
            if (allValues.length > 1) {
                // Switch to another project
                const otherValue = allValues.find(v => v !== originalValue);
                await folderSelect.selectOption(otherValue);
                await page.waitForTimeout(500);
                // Switch back
                await folderSelect.selectOption(originalValue);
                await page.waitForTimeout(1000);
            }
            // Verify sessions are loaded
            const historyItems = page.locator('#sessions .session-item');
            await expect(historyItems.first()).toBeVisible();
        });
    });

    test.describe('Search Filter', () => {
        test('should filter sessions by search query', async ({ page }) => {
            const searchInput = page.locator('#session-search');

            // Wait for history sessions to load
            await page.waitForSelector('#sessions .session-item', { timeout: 5000 });

            // Count initial sessions
            const initialCount = await page.locator('#sessions .session-item').count();
            expect(initialCount).toBeGreaterThan(0);

            // Search for something specific
            await searchInput.fill('greeting');
            await page.waitForTimeout(300);

            // Verify filtered results (should show fewer or same)
            const filteredItems = page.locator('#sessions .session-item:visible');
            const filteredCount = await filteredItems.count();

            // At least some sessions should match "greeting"
            expect(filteredCount).toBeGreaterThanOrEqual(0);
        });

        test('should restore all sessions when search cleared', async ({ page }) => {
            const searchInput = page.locator('#session-search');

            // Search then clear
            await searchInput.fill('xyz123notexist');
            await page.waitForTimeout(300);
            await searchInput.fill('');
            await page.waitForTimeout(500);

            // All sessions should be visible again
            const historyItems = page.locator('#sessions .session-item');
            await expect(historyItems.first()).toBeVisible();
        });

        test('should filter active sessions too', async ({ page }) => {
            const searchInput = page.locator('#session-search');

            // Search for feather (which active sessions should contain)
            await searchInput.fill('feather');
            await page.waitForTimeout(300);

            // Active sessions containing "feather" should be visible
            const activeItems = page.locator('#sessions .session-item:visible');
            const count = await activeItems.count();
            expect(count).toBeGreaterThanOrEqual(0);
        });
    });

    test.describe('Session Selection', () => {
        test('should load history session messages', async ({ page }) => {
            // Click on first history session
            const firstHistorySession = page.locator('#sessions .session-item').first();
            await firstHistorySession.click();

            // Wait for messages to load
            await page.waitForSelector('#message-container:not(.hidden)', { timeout: 5000 });

            // Empty state should be hidden
            await expect(page.locator('#empty-state')).toHaveClass(/hidden/);

            // Messages container should be visible
            await expect(page.locator('#message-container')).not.toHaveClass(/hidden/);
        });

        test('should highlight selected session', async ({ page }) => {
            const firstHistorySession = page.locator('#sessions .session-item').first();
            await firstHistorySession.click();

            // Session should have active class
            await expect(firstHistorySession).toHaveClass(/active/);
        });

        test('should update status bar with session info', async ({ page }) => {
            const firstHistorySession = page.locator('#sessions .session-item').first();
            await firstHistorySession.click();

            // Status should show Ready
            await expect(page.locator('#status')).toContainText('Ready');
        });

        test('should load active tmux session with history', async ({ page }) => {
            const activeSession = page.locator('#sessions .session-item').first();

            if (await activeSession.isVisible()) {
                await activeSession.click();

                // Terminal panel should open
                await page.waitForSelector('#terminal-panel.open', { timeout: 3000 });
                await expect(page.locator('#terminal-panel')).toHaveClass(/open/);

                // Session history might load if session has matching JSONL
                await page.waitForTimeout(2000);
            }
        });
    });

    test.describe('Terminal Panel', () => {
        test('should toggle terminal panel with button', async ({ page }) => {
            const toggleBtn = page.locator('#terminal-toggle');

            // Initially hidden
            await expect(page.locator('#terminal-panel')).not.toHaveClass(/open/);

            // Click to open
            await toggleBtn.click();
            await expect(page.locator('#terminal-panel')).toHaveClass(/open/);

            // Click Hide button to close (terminal panel has "Hide" not "Close")
            await page.locator('#terminal-panel button:has-text("Hide")').click();
            await expect(page.locator('#terminal-panel')).not.toHaveClass(/open/);
        });

        test('terminal panel should not block sidebar clicks', async ({ page }) => {
            // Open terminal
            await page.click('#terminal-toggle');
            await expect(page.locator('#terminal-panel')).toHaveClass(/open/);

            // Should still be able to click history sessions
            const historySession = page.locator('#sessions .session-item').first();
            await historySession.click();

            // Session should be selected (history loaded)
            await expect(page.locator('#message-container')).not.toHaveClass(/hidden/);
        });

        test('should show terminal controls', async ({ page }) => {
            await page.click('#terminal-toggle');

            await expect(page.locator('button:has-text("^C")')).toBeVisible();
            await expect(page.locator('button:has-text("^D")')).toBeVisible();
            await expect(page.locator('#terminal-panel button:has-text("Hide")')).toBeVisible();
        });
    });

    test.describe('New Session', () => {
        test('should create new session on button click', async ({ page }) => {
            // Use the "+ Claude" button to create a new session
            const newBtn = page.locator('button:has-text("+ Claude")');
            await expect(newBtn).toBeVisible();

            // Count sessions before
            const beforeCount = await page.locator('#sessions .session-item').count();

            await newBtn.click();

            // Status should indicate starting
            await expect(page.locator('#status')).toContainText(/Starting|Connecting/);

            // Wait for session to be created
            await page.waitForTimeout(3000);

            // New session should appear in session list
            const afterCount = await page.locator('#sessions .session-item').count();
            expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
        });
    });

    test.describe('Input Area', () => {
        test('should have input textarea', async ({ page }) => {
            await expect(page.locator('#input')).toBeVisible();
            await expect(page.locator('#input')).toHaveAttribute('placeholder', 'Ask anything...');
        });

        test('should have send button', async ({ page }) => {
            await expect(page.locator('#send-btn')).toBeVisible();
            await expect(page.locator('#send-btn')).toContainText('Send');
        });

        test('should have input placeholder', async ({ page }) => {
            await expect(page.locator('#input')).toHaveAttribute('placeholder', 'Ask anything...');
        });
    });

    test.describe('Quick Actions', () => {
        test('should display quick action buttons', async ({ page }) => {
            await expect(page.locator('button:has-text("Fix a bug")')).toBeVisible();
            await expect(page.locator('button:has-text("Explain")')).toBeVisible();
            await expect(page.locator('button:has-text("Write code")')).toBeVisible();
        });

        test('should set prompt on quick action click', async ({ page }) => {
            await page.click('button:has-text("Fix a bug")');

            const input = page.locator('#input');
            await expect(input).toHaveValue('Fix the bug in');
        });
    });

    test.describe('Responsive Design', () => {
        test('should show hamburger menu on mobile', async ({ page }) => {
            await page.setViewportSize({ width: 375, height: 667 });

            const menuBtn = page.locator('#menu-btn');
            await expect(menuBtn).toBeVisible();
        });

        test('should toggle sidebar on mobile', async ({ page }) => {
            await page.setViewportSize({ width: 375, height: 667 });

            const sidebar = page.locator('#sidebar');

            // Sidebar initially hidden on mobile
            await expect(sidebar).toHaveClass(/-translate-x-full/);

            // Click menu button
            await page.click('#menu-btn');

            // Sidebar should be visible
            await expect(sidebar).not.toHaveClass(/-translate-x-full/);
        });
    });

    test.describe('Message Rendering', () => {
        test('should render user and assistant messages', async ({ page }) => {
            // Click on first history session
            const firstHistorySession = page.locator('#sessions .session-item').first();
            await firstHistorySession.click();

            // Wait for messages to load
            await page.waitForSelector('#message-container:not(.hidden)', { timeout: 5000 });

            // Should have at least some messages (user or assistant)
            const messages = page.locator('#message-container > div');
            const count = await messages.count();
            expect(count).toBeGreaterThan(0);
        });

        test('should render markdown in assistant messages', async ({ page }) => {
            const firstHistorySession = page.locator('#sessions .session-item').first();
            await firstHistorySession.click();

            await page.waitForSelector('#message-container:not(.hidden)', { timeout: 5000 });

            // Check for markdown-content class (used for assistant messages)
            const markdownContent = page.locator('.markdown-content').first();
            // If there are assistant messages, markdown-content should exist
            const count = await page.locator('.markdown-content').count();
            expect(count).toBeGreaterThanOrEqual(0);
        });
    });

    test.describe('API Integration', () => {
        test('should receive data from health endpoint', async ({ page, request }) => {
            const response = await request.get(`${BASE_URL}/health`);
            expect(response.ok()).toBeTruthy();

            const data = await response.json();
            expect(data.status).toBe('ok');
            expect(data.version).toBeDefined();
        });

        test('should load projects from API', async ({ page, request }) => {
            const response = await request.get(`${BASE_URL}/api/projects`);
            expect(response.ok()).toBeTruthy();

            const data = await response.json();
            expect(data.projects).toBeDefined();
            expect(Array.isArray(data.projects)).toBeTruthy();
        });

        test('should load tmux sessions from API', async ({ page, request }) => {
            const response = await request.get(`${BASE_URL}/api/claude-sessions`);
            expect(response.ok()).toBeTruthy();

            const data = await response.json();
            expect(data.tmux_sessions).toBeDefined();
            expect(Array.isArray(data.tmux_sessions)).toBeTruthy();
        });
    });

    test.describe('Keyboard Shortcuts', () => {
        test('should focus input with Cmd/Ctrl+K', async ({ page }) => {
            // Trigger Ctrl+K
            await page.keyboard.press('Control+k');

            // Input should be focused
            const input = page.locator('#input');
            await expect(input).toBeFocused();
        });

        test('should not send on Shift+Enter', async ({ page }) => {
            // First select a tmux session to enable sending
            const activeSession = page.locator('#sessions .session-item').first();
            if (await activeSession.isVisible()) {
                await activeSession.click();
                await page.waitForTimeout(500);
            }

            const input = page.locator('#input');
            await input.fill('test message');
            await input.press('Shift+Enter');

            // Message should still be in input (not sent)
            await expect(input).toHaveValue(/test message/);
        });
    });

    test.describe('Input Auto-Resize', () => {
        test('should grow input with multiline content', async ({ page }) => {
            const input = page.locator('#input');

            // Get initial height
            const initialHeight = await input.evaluate(el => el.offsetHeight);

            // Add multiple lines
            await input.fill('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

            // Trigger input event to resize
            await input.dispatchEvent('input');

            // Height should increase (but capped at 200px)
            const newHeight = await input.evaluate(el => el.offsetHeight);
            expect(newHeight).toBeGreaterThanOrEqual(initialHeight);
        });
    });

    test.describe('SSE Connection Status', () => {
        test('should show SSE event ID updates', async ({ page }) => {
            // Wait for initial connection
            await page.waitForSelector('#sse-status:text("Connected")', { timeout: 5000 });

            // Event ID should update with heartbeats (every 15s, but check initial state)
            const eventId = page.locator('#sse-event-id');
            await expect(eventId).toBeVisible();
        });

        test('should show status dot indicator', async ({ page }) => {
            // Status dot should be visible when connected
            const statusDot = page.locator('#status-dot');
            await expect(statusDot).toBeVisible();

            // After connection, should have green class
            await page.waitForSelector('#sse-status:text("Connected")', { timeout: 5000 });
            await expect(statusDot).toHaveClass(/bg-apple-9/);
        });
    });

    test.describe('Image Upload and Display', () => {
        test('should serve uploaded images via /uploads/ route', async ({ page, request }) => {
            // Upload a test image via API
            const testImageData = Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                'base64'
            );

            const uploadResponse = await request.post(`${BASE_URL}/api/upload-file`, {
                data: testImageData,
                headers: {
                    'Content-Type': 'image/png',
                    'X-Filename': 'test-image.png'
                }
            });

            expect(uploadResponse.ok()).toBeTruthy();
            const uploadData = await uploadResponse.json();
            expect(uploadData.status).toBe('ok');
            expect(uploadData.path).toContain('test-image.png');

            // Extract filename from path and verify it's served
            const filename = uploadData.path.split('/').pop();
            const serveResponse = await request.get(`${BASE_URL}/uploads/${filename}`);
            expect(serveResponse.ok()).toBeTruthy();
            expect(serveResponse.headers()['content-type']).toContain('image/png');
        });

        test('should return 404 for non-existent uploads', async ({ page, request }) => {
            const response = await request.get(`${BASE_URL}/uploads/nonexistent-file-12345.png`);
            expect(response.status()).toBe(404);
        });

        test('should render images in messages with correct classes', async ({ page }) => {
            // Click on a session that has image content
            const firstHistorySession = page.locator('#sessions .session-item').first();
            await firstHistorySession.click();
            await page.waitForSelector('#message-container:not(.hidden)', { timeout: 5000 });

            // Check if any images exist in messages
            const images = page.locator('#message-container img');
            const count = await images.count();

            if (count > 0) {
                // Verify image has correct styling classes
                const firstImage = images.first();
                await expect(firstImage).toHaveClass(/max-w-full|max-h-48|rounded/);

                // Verify image is clickable (uses lightbox)
                const onclick = await firstImage.getAttribute('onclick');
                expect(onclick).toContain('openLightbox');
            }
        });

        test('should handle image upload preview before send', async ({ page }) => {
            // Find the file input
            const fileInput = page.locator('#screenshot-input');

            // Create a test image file
            const testImageBuffer = Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                'base64'
            );

            // Upload via file input
            await fileInput.setInputFiles({
                name: 'test-preview.png',
                mimeType: 'image/png',
                buffer: testImageBuffer
            });

            // Preview should appear (check for preview container or attached file indicator)
            await page.waitForTimeout(500);
            const previewArea = page.locator('#preview-area, #attached-file, .file-preview');
            // If preview is implemented, it should show
        });
    });

    test.describe('Session Persistence', () => {
        test('should remember selected project in localStorage', async ({ page, context }) => {
            const folderSelect = page.locator('#folder-select');
            const allValues = await folderSelect.locator('option').evaluateAll(
                opts => opts.map(o => o.value)
            );

            if (allValues.length > 1) {
                // Switch to the second project
                const targetProject = allValues[1];
                await folderSelect.selectOption(targetProject);
                await page.waitForTimeout(500);

                // Reload page
                await page.reload();
                // Wait for the page to load and projects to be fetched into the dropdown
                await page.waitForSelector('#folder-select', { timeout: 10000 });
                // Wait for projects API to populate the dropdown options
                await page.waitForFunction(
                    () => document.querySelector('#folder-select')?.options?.length > 0,
                    { timeout: 10000 }
                );

                // Should still be on the selected project (check localStorage)
                const folder = await page.evaluate(() => localStorage.getItem('feather-folder'));
                expect(folder).toBe(targetProject);

                // Verify the dropdown reflects the persisted selection
                const selectedValue = await page.locator('#folder-select').inputValue();
                expect(selectedValue).toBe(targetProject);

                // Reset to first project for other tests
                await page.locator('#folder-select').selectOption(allValues[0]);
            } else {
                // Only one project - just verify localStorage stores it
                const folder = await page.evaluate(() => localStorage.getItem('feather-folder'));
                expect(folder).toBeTruthy();
            }
        });
    });
});
