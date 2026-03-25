#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
SESSION_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
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
    await page.getByRole('button', { name: 'Terminal' }).click();
    await page.waitForTimeout(2500);

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('.xterm-rows > div')]
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
    );
    const snapshot = await page.locator('body').ariaSnapshot();

    const hasVisibleTranscript = rows.length > 0;
    const transcriptMissingFromA11yTree = hasVisibleTranscript && rows.every((row) => !snapshot.includes(row));
    const exposesOnlyInput = snapshot.includes('textbox "Terminal input"');
    const bugPresent = hasVisibleTranscript && transcriptMissingFromA11yTree && exposesOnlyInput;

    console.log(JSON.stringify({
      rows,
      snapshot,
      hasVisibleTranscript,
      transcriptMissingFromA11yTree,
      exposesOnlyInput,
      bugPresent,
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
