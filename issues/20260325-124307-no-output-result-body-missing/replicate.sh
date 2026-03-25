#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
SESSION_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
TARGET_TEXT="(Bash completed with no output)"
NODE_PATH="${NODE_PATH:-/home/user/feather/node_modules}"

API_JSON="$(curl -fsS "http://localhost:${PORT}/api/sessions/${SESSION_ID}/messages?limit=500")"

if ! printf '%s' "${API_JSON}" | node -e '
const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const messages = Array.isArray(payload.messages) ? payload.messages : [];

const found = messages.some((message) =>
  Array.isArray(message.content) &&
  message.content.some((block) =>
    block &&
    block.type === "tool_result" &&
    block.content === process.argv[1]
  )
);

process.exit(found ? 0 : 1);
' "${TARGET_TEXT}"
then
  echo "BUG ABSENT: target no-output tool_result is no longer stored in the session API"
  exit 1
fi

PORT="${PORT}" SESSION_ID="${SESSION_ID}" TARGET_TEXT="${TARGET_TEXT}" NODE_PATH="${NODE_PATH}" node - <<'NODE'
const { chromium } = require('playwright');

const port = process.env.PORT;
const sessionId = process.env.SESSION_ID;
const targetText = process.env.TARGET_TEXT;

(async() => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  try {
    await page.goto(`http://localhost:${port}/#${sessionId}`, { waitUntil: 'load', timeout: 10000 });
    await page.waitForTimeout(2000);

    const details = await page.evaluate((needle) => {
      const target = [...document.querySelectorAll('div')].find((el) => (el.textContent || '').trim() === needle);
      if (!target) {
        return { found: false };
      }

      target.scrollIntoView({ block: 'center' });

      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          const rect = target.getBoundingClientRect();
          const style = getComputedStyle(target);
          const card = target.parentElement;
          const cardRect = card ? card.getBoundingClientRect() : null;

          resolve({
            found: true,
            text: (target.textContent || '').trim(),
            rect,
            cardRect,
            style: {
              display: style.display,
              visibility: style.visibility,
              opacity: style.opacity,
              fontSize: style.fontSize,
              lineHeight: style.lineHeight,
            },
          });
        });
      });
    }, targetText);

    const visibleBody =
      details.found &&
      details.text === targetText &&
      details.style.display !== 'none' &&
      details.style.visibility !== 'hidden' &&
      Number(details.style.opacity) > 0 &&
      details.rect.width >= 120 &&
      details.rect.height >= 20 &&
      details.rect.top >= 0 &&
      details.rect.bottom <= 844 &&
      details.cardRect &&
      details.cardRect.height >= 40;

    const bugPresent = !visibleBody;

    console.log(JSON.stringify({ details, visibleBody, bugPresent }, null, 2));

    await browser.close();
    process.exit(bugPresent ? 0 : 1);
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    await browser.close();
    process.exit(1);
  }
})();
NODE
