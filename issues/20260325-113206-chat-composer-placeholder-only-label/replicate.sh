#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
SESSION_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
NODE_PATH="${NODE_PATH:-/home/user/feather/node_modules}"

PORT="$PORT" NODE_PATH="$NODE_PATH" node - <<'NODE'
const { chromium } = require('playwright');

const port = process.env.PORT;
const sessionId = '370e2f60-1399-4ebf-a182-7a8ba6c59ccf';

(async() => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  try {
    await page.goto(`http://localhost:${port}/#${sessionId}`, { waitUntil: 'load', timeout: 10000 });
    await page.waitForTimeout(2000);

    const details = await page.evaluate(() => {
      const textarea = [...document.querySelectorAll('textarea')].find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      });

      if (!textarea) {
        return { found: false };
      }

      const labelRefs = (textarea.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .map((id) => id.trim())
        .filter(Boolean);

      const referencedLabels = labelRefs
        .map((id) => document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim() || '')
        .filter(Boolean);

      const associatedLabels = textarea.labels ? [...textarea.labels].map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean) : [];

      return {
        found: true,
        placeholder: textarea.getAttribute('placeholder') || '',
        ariaLabel: (textarea.getAttribute('aria-label') || '').trim(),
        ariaLabelledby: (textarea.getAttribute('aria-labelledby') || '').trim(),
        associatedLabels,
        referencedLabels,
      };
    });

    const snapshot = await page.locator('body').ariaSnapshot();
    const placeholderNamedInA11yTree = snapshot.includes('textbox "Send a message..."');
    const hasRealLabel =
      details.found &&
      (details.ariaLabel !== '' ||
        details.ariaLabelledby !== '' ||
        details.associatedLabels.length > 0 ||
        details.referencedLabels.length > 0);

    const bugPresent =
      details.found &&
      details.placeholder === 'Send a message...' &&
      !hasRealLabel &&
      placeholderNamedInA11yTree;

    console.log(JSON.stringify({
      details,
      placeholderNamedInA11yTree,
      hasRealLabel,
      bugPresent,
      snapshot,
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
