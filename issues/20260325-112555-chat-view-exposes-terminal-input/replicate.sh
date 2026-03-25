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

    const snapshot = await page.locator('body').ariaSnapshot();
    const state = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const composer = document.querySelector('textarea[placeholder="Send a message..."]');
      const chatButton = buttons.find((button) => (button.textContent || '').trim() === 'Chat');
      const terminalA11yNodes = [...document.querySelectorAll('textarea[aria-label="Terminal input"], div[role="textbox"][aria-label="Terminal input"]')]
        .map((node) => ({
          tag: node.tagName,
          role: node.getAttribute('role'),
          display: getComputedStyle(node).display,
          visibility: getComputedStyle(node).visibility,
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
        }));

      return {
        chatVisible: !!chatButton,
        chatSelected: !!chatButton && getComputedStyle(chatButton).borderBottomWidth !== '0px',
        composerVisible: !!composer,
        composerNameInDom: composer?.getAttribute('placeholder') || null,
        terminalA11yNodes,
      };
    });

    const exposesTerminalInput = snapshot.includes('textbox "Terminal input"');
    const exposesComposer = snapshot.includes('textbox "Send a message..."');
    const bugPresent = state.chatVisible && state.chatSelected && state.composerVisible && exposesTerminalInput && !exposesComposer;

    console.log(JSON.stringify({
      state,
      exposesTerminalInput,
      exposesComposer,
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
