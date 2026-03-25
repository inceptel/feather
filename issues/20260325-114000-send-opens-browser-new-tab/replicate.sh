#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
NODE_PATH="${NODE_PATH:-/home/user/feather/node_modules}"

PORT="$PORT" NODE_PATH="$NODE_PATH" node - <<'NODE'
const { chromium } = require('playwright');

const port = process.env.PORT;
const sessionId = '4baa1292-7fdf-4e87-af47-6731e459b3cd';
const probe = `worker5 send-new-tab probe ${Date.now()}`;
const startUrl = `http://localhost:${port}/#${sessionId}`;

(async() => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2500);

    const textarea = page.locator('textarea').first();
    const sendButton = page.getByRole('button', { name: 'Send' });

    await textarea.waitFor({ state: 'visible', timeout: 10000 });
    await textarea.fill(probe);
    await sendButton.click();
    await page.waitForTimeout(1500);

    const details = await page.evaluate(({ expectedHref, probeText }) => {
      const href = location.href;
      const title = document.title;
      const bodyText = document.body.innerText || '';
      const stayedInFeather = href === expectedHref && !href.startsWith('chrome://');
      const landedOnNewTab = href === 'chrome://new-tab-page/' || title === 'New Tab';

      return {
        href,
        title,
        bodyIncludesProbe: bodyText.includes(probeText),
        stayedInFeather,
        landedOnNewTab,
      };
    }, { expectedHref: startUrl, probeText: probe });

    const bugPresent = details.landedOnNewTab;

    console.log(JSON.stringify({
      startUrl,
      probe,
      bugPresent,
      details,
    }, null, 2));

    await browser.close();
    process.exit(bugPresent ? 0 : 1);
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    await browser.close();
    process.exit(1);
  }
})();
NODE
