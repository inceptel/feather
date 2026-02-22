/**
 * Feather-rs Visual Tests
 *
 * Uses Claude CLI to analyze screenshots - no API key needed!
 * Just like the Claude process you're chatting with now.
 *
 * Run with:
 *   npm run test:visual
 *
 * To update baselines:
 *   UPDATE_BASELINES=1 npm run test:visual
 */

const { test, expect } = require('@playwright/test');
const {
    validateScreenshot,
    compareScreenshots,
    saveBaseline,
    loadBaseline,
    baselineExists,
    isClaudeAvailable
} = require('./visual-helper');

const BASE_URL = process.env.FEATHER_URL || 'http://localhost:4850';
const UPDATE_BASELINES = process.env.UPDATE_BASELINES === '1';

// Check Claude CLI availability
if (!isClaudeAvailable()) {
    console.log('\n⚠️  Claude CLI not found - visual analysis will be skipped');
    console.log('   Install with: npm install -g @anthropic-ai/claude-cli\n');
}

// Visual tests are slower due to Claude CLI calls
test.setTimeout(120000);

test.describe('Visual Tests', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(BASE_URL);
        await page.waitForSelector('.session-item', { timeout: 10000 });
        // Wait for SSE connection
        await page.waitForSelector('#sse-status:text("Connected")', { timeout: 5000 });
    });

    test.describe('Homepage Layout', () => {
        test('should display correct homepage layout', async ({ page }) => {
            const screenshot = await page.screenshot({ fullPage: false });

            const result = await validateScreenshot(screenshot,
                'Homepage of Feather Rust app with: ' +
                '1) Left sidebar containing "Feather Rust" branding with feather emoji, ' +
                '2) CODE/LIFE folder tabs, ' +
                '3) "+ New" gold/orange button, ' +
                '4) Search input field, ' +
                '5) ACTIVE sessions section with green dot, ' +
                '6) HISTORY sessions list, ' +
                '7) Main content area showing "What can I help with?" welcome message, ' +
                '8) Quick action buttons (Fix a bug, Explain, Write code), ' +
                '9) Bottom input area with "Ask anything..." placeholder'
            );

            console.log('Homepage analysis:', result.analysis);
            if (result.issues.length > 0) {
                console.log('Issues found:', result.issues);
            }

            expect(result.pass, `Visual validation failed: ${result.issues.join(', ')}`).toBe(true);
        });

        test('should have proper dark theme styling', async ({ page }) => {
            const screenshot = await page.screenshot();

            const result = await validateScreenshot(screenshot,
                'Dark-themed UI with: ' +
                '1) Very dark background (near black), ' +
                '2) Gold/orange accent colors for branding and primary buttons, ' +
                '3) Light gray text on dark backgrounds, ' +
                '4) Subtle borders between sections, ' +
                '5) Green status indicators for active/connected states'
            );

            console.log('Theme analysis:', result.analysis);
            expect(result.pass, `Theme issues: ${result.issues.join(', ')}`).toBe(true);
        });
    });

    test.describe('Sidebar States', () => {
        test('should show session list correctly', async ({ page }) => {
            // Wait for sessions to populate
            await page.waitForTimeout(1000);
            const screenshot = await page.screenshot();

            const result = await validateScreenshot(screenshot,
                'Sidebar showing: ' +
                '1) Multiple session items in a list, ' +
                '2) Each session has a title and timestamp (like "2h", "5d"), ' +
                '3) Sessions have subtle hover/selection styling, ' +
                '4) ACTIVE section at top with green pulsing dot, ' +
                '5) HISTORY section below with session cards'
            );

            console.log('Session list analysis:', result.analysis);
            expect(result.pass, `Session list issues: ${result.issues.join(', ')}`).toBe(true);
        });

        test('should highlight selected session', async ({ page }) => {
            // Click on first history session
            await page.locator('#sessions .session-item').first().click();
            await page.waitForTimeout(500);

            const screenshot = await page.screenshot();

            const result = await validateScreenshot(screenshot,
                'Sidebar with one session highlighted/selected, showing: ' +
                '1) Selected session has gold/orange left border, ' +
                '2) Selected session has slightly different background, ' +
                '3) Main area now shows message content (not welcome screen), ' +
                '4) Status bar shows "Ready" status'
            );

            console.log('Selected session analysis:', result.analysis);
            expect(result.pass, `Selection issues: ${result.issues.join(', ')}`).toBe(true);
        });
    });

    test.describe('Message Display', () => {
        test('should render conversation messages correctly', async ({ page }) => {
            // Click on a history session to load messages
            await page.locator('#sessions .session-item').first().click();
            await page.waitForSelector('#message-container:not(.hidden)', { timeout: 5000 });
            await page.waitForTimeout(1000);

            const screenshot = await page.screenshot();

            const result = await validateScreenshot(screenshot,
                'Conversation view showing: ' +
                '1) User messages aligned to the right with gold/orange tinted background, ' +
                '2) Assistant messages aligned to the left with darker background, ' +
                '3) Messages have rounded corners (chat bubble style), ' +
                '4) Text is readable with proper line height, ' +
                '5) Code blocks (if any) have syntax highlighting with dark background'
            );

            console.log('Message display analysis:', result.analysis);
            expect(result.pass, `Message display issues: ${result.issues.join(', ')}`).toBe(true);
        });
    });

    test.describe('Terminal Panel', () => {
        test('should display terminal panel correctly when open', async ({ page }) => {
            // Open terminal
            await page.click('#terminal-toggle');
            await page.waitForSelector('#terminal-panel.open');
            await page.waitForTimeout(500);

            const screenshot = await page.screenshot();

            const result = await validateScreenshot(screenshot,
                'Terminal panel visible at bottom of screen showing: ' +
                '1) Panel header with "TMUX TERMINAL" label in gold, ' +
                '2) Control buttons (^C, ^D, Close), ' +
                '3) Dark terminal area below header, ' +
                '4) Panel does NOT cover the sidebar on the left, ' +
                '5) Terminal toggle button in header should appear active/highlighted'
            );

            console.log('Terminal panel analysis:', result.analysis);
            expect(result.pass, `Terminal panel issues: ${result.issues.join(', ')}`).toBe(true);
        });
    });

    test.describe('Mobile Responsive', () => {
        test('should adapt layout for mobile', async ({ page }) => {
            await page.setViewportSize({ width: 375, height: 667 });
            await page.waitForTimeout(500);

            const screenshot = await page.screenshot();

            const result = await validateScreenshot(screenshot,
                'Mobile layout showing: ' +
                '1) Hamburger menu button (three lines) visible in top left, ' +
                '2) Sidebar is hidden (not visible), ' +
                '3) Main content area fills the width, ' +
                '4) Welcome message and quick actions are visible, ' +
                '5) Input area at bottom is full width'
            );

            console.log('Mobile layout analysis:', result.analysis);
            expect(result.pass, `Mobile layout issues: ${result.issues.join(', ')}`).toBe(true);
        });

        test('should show sidebar when menu clicked on mobile', async ({ page }) => {
            await page.setViewportSize({ width: 375, height: 667 });
            await page.click('#menu-btn');
            await page.waitForTimeout(500);

            const screenshot = await page.screenshot();

            const result = await validateScreenshot(screenshot,
                'Mobile with sidebar open showing: ' +
                '1) Sidebar is now visible, sliding in from left, ' +
                '2) Dark overlay behind sidebar covering main content, ' +
                '3) Sidebar shows Feather Rust branding, folder tabs, sessions, ' +
                '4) Sidebar takes up most but not all of the screen width'
            );

            console.log('Mobile sidebar analysis:', result.analysis);
            expect(result.pass, `Mobile sidebar issues: ${result.issues.join(', ')}`).toBe(true);
        });
    });

    test.describe('Visual Regression', () => {
        test('homepage should match baseline', async ({ page }) => {
            const screenshot = await page.screenshot();
            const baselineName = 'homepage';

            if (UPDATE_BASELINES || !baselineExists(baselineName)) {
                saveBaseline(screenshot, baselineName);
                console.log('Baseline saved. Re-run test without UPDATE_BASELINES to compare.');
                return;
            }

            const baseline = loadBaseline(baselineName);
            const result = await compareScreenshots(screenshot, baseline, 'Homepage comparison');

            console.log('Regression analysis:', result.analysis);
            console.log('Similarity:', result.similarity);

            if (result.differences.length > 0) {
                console.log('Differences:', result.differences);
            }

            // Allow some flexibility (0.85 = 85% similar)
            expect(result.similarity, `Visual regression detected: ${result.differences.join(', ')}`).toBeGreaterThan(0.85);
        });

        test('session view should match baseline', async ({ page }) => {
            await page.locator('#sessions .session-item').first().click();
            await page.waitForSelector('#message-container:not(.hidden)', { timeout: 5000 });
            await page.waitForTimeout(1000);

            const screenshot = await page.screenshot();
            const baselineName = 'session-view';

            if (UPDATE_BASELINES || !baselineExists(baselineName)) {
                saveBaseline(screenshot, baselineName);
                console.log('Baseline saved. Re-run test without UPDATE_BASELINES to compare.');
                return;
            }

            const baseline = loadBaseline(baselineName);
            const result = await compareScreenshots(screenshot, baseline, 'Session view comparison');

            console.log('Regression analysis:', result.analysis);
            console.log('Similarity:', result.similarity);

            // Session content can vary, so be more lenient
            expect(result.similarity, `Visual regression: ${result.differences.join(', ')}`).toBeGreaterThan(0.75);
        });
    });

    test.describe('Accessibility Checks', () => {
        test('should have sufficient color contrast', async ({ page }) => {
            const screenshot = await page.screenshot();

            const result = await validateScreenshot(screenshot,
                'Check for accessibility: ' +
                '1) Text should be clearly readable against backgrounds, ' +
                '2) Interactive elements (buttons) should be clearly distinguishable, ' +
                '3) Status indicators should be visible (green dots, etc.), ' +
                '4) No text that blends into background, ' +
                '5) Input fields should have visible borders or backgrounds',
                { model: 'claude-sonnet-4-20250514' }
            );

            console.log('Accessibility analysis:', result.analysis);
            if (!result.pass) {
                console.log('Accessibility issues:', result.issues);
            }

            expect(result.pass, `Accessibility issues: ${result.issues.join(', ')}`).toBe(true);
        });
    });
});
