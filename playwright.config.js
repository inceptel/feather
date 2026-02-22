// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright configuration for Feather-rs E2E tests
 *
 * Run tests:
 *   npx playwright test
 *
 * Run with UI:
 *   npx playwright test --ui
 *
 * Run headed:
 *   npx playwright test --headed
 */

module.exports = defineConfig({
    testDir: './tests',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'html',
    timeout: 30000,

    use: {
        baseURL: process.env.FEATHER_URL || 'http://localhost:4850',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],

    /* Run feather-rs server before starting tests */
    // Uncomment if you want tests to auto-start the server
    // webServer: {
    //     command: 'PORT=4850 ./target/release/feather-rs',
    //     url: 'http://localhost:4850/health',
    //     reuseExistingServer: !process.env.CI,
    //     timeout: 120000,
    // },
});
