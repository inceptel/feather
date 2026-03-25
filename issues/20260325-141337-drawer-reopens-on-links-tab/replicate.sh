#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
NODE_PATH="${NODE_PATH:-/home/user/feather/node_modules}"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"

SOURCE_STATE="$(
node - "$APP_TSX" <<'NODE'
const fs = require('fs');

const source = fs.readFileSync(process.argv[2], 'utf8');

const hasNewClaude = source.includes('+ New Claude');
const hasCloseDrawerLabel = source.includes('Close session drawer');
const hasLinksText = source.includes('Links');
const hasSessionsText = source.includes('Sessions');
const hasQuickLinksCopy = source.includes('No quick links yet. Use /feather add link to add some.');

process.stdout.write(JSON.stringify({
  hasNewClaude,
  hasCloseDrawerLabel,
  hasLinksText,
  hasSessionsText,
  hasQuickLinksCopy,
}));
NODE
)"

BROWSER_STATE="$(
PORT="$PORT" NODE_PATH="$NODE_PATH" node - <<'NODE'
const { chromium } = require('playwright');

const port = process.env.PORT;
const helperCopy = 'No quick links yet. Use /feather add link to add some.';

function normalize(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

(async() => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  try {
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1200);

    const initial = await page.evaluate(() => ({
      text: document.body.innerText,
      buttonLabels: [...document.querySelectorAll('button')].map((button) => ({
        text: (button.textContent || '').replace(/\s+/g, ' ').trim(),
        ariaLabel: button.getAttribute('aria-label') || '',
      })),
    }));

    await page.getByRole('button').first().click();
    await page.waitForTimeout(500);

    const afterOpen = await page.evaluate((expectedHelperCopy) => {
      const text = document.body.innerText;
      const labels = [...document.querySelectorAll('button')].map((button) => ({
        text: (button.textContent || '').replace(/\s+/g, ' ').trim(),
        ariaLabel: button.getAttribute('aria-label') || '',
      }));
      return {
        text,
        buttonLabels: labels,
        hasNewClaude: text.includes('+ New Claude'),
        hasLinksButton: labels.some((entry) => entry.text === 'Links'),
        hasSessionsButton: labels.some((entry) => entry.text === 'Sessions'),
        hasHelperCopy: text.includes(expectedHelperCopy),
      };
    }, helperCopy);

    let linksPane = null;
    let afterReopen = null;

    if (afterOpen.hasLinksButton) {
      await page.getByRole('button', { name: 'Links', exact: true }).click();
      await page.waitForTimeout(400);

      linksPane = await page.evaluate((expectedHelperCopy) => {
        const text = document.body.innerText;
        return {
          text,
          hasHelperCopy: text.includes(expectedHelperCopy),
          hasNewClaude: text.includes('+ New Claude'),
        };
      }, helperCopy);

      await page.getByRole('button', { name: 'Close session drawer' }).click();
      await page.waitForTimeout(400);
      await page.getByRole('button').first().click();
      await page.waitForTimeout(500);

      afterReopen = await page.evaluate((expectedHelperCopy) => {
        const text = document.body.innerText;
        const labels = [...document.querySelectorAll('button')].map((button) => ({
          text: (button.textContent || '').replace(/\s+/g, ' ').trim(),
          ariaLabel: button.getAttribute('aria-label') || '',
        }));
        return {
          text,
          buttonLabels: labels,
          hasNewClaude: text.includes('+ New Claude'),
          hasLinksButton: labels.some((entry) => entry.text === 'Links'),
          hasSessionsButton: labels.some((entry) => entry.text === 'Sessions'),
          hasHelperCopy: text.includes(expectedHelperCopy),
        };
      }, helperCopy);
    }

    const bugPresent = Boolean(
      afterOpen.hasLinksButton &&
      afterOpen.hasSessionsButton &&
      linksPane &&
      linksPane.hasHelperCopy &&
      !linksPane.hasNewClaude &&
      afterReopen &&
      afterReopen.hasLinksButton &&
      afterReopen.hasSessionsButton &&
      afterReopen.hasHelperCopy &&
      !afterReopen.hasNewClaude
    );

    console.log(JSON.stringify({
      initial,
      afterOpen,
      linksPane,
      afterReopen,
      bugPresent,
    }));
    await browser.close();
  } catch (error) {
    console.log(JSON.stringify({
      bugPresent: false,
      error: error && error.message ? error.message : String(error),
    }));
    await browser.close();
  }
})();
NODE
)"

BUG_PRESENT="$(jq -n \
  --argjson browser "$BROWSER_STATE" \
  '$browser.bugPresent == true'
)"

if [ "$BUG_PRESENT" = "true" ]; then
  echo "BUG PRESENT: reopening the mobile drawer preserves the stale Links pane and hides the session list and + New Claude action"
  exit 0
fi

echo "BUG ABSENT: source=$SOURCE_STATE browser=$BROWSER_STATE"
exit 1
