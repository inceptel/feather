#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
NODE_PATH="${NODE_PATH:-/home/user/feather/node_modules}"
SESSION_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"

PORT="$PORT" NODE_PATH="$NODE_PATH" SESSION_ID="$SESSION_ID" node - <<'NODE'
const http = require('http');
const { chromium } = require('playwright');

const port = process.env.PORT;
const sessionId = process.env.SESSION_ID;

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}${path}`, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${path} failed with ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
  });
}

(async() => {
  const sessionsPayload = await getJson('/api/sessions');
  const sessionMeta = (sessionsPayload.sessions || []).find((entry) => entry.id === sessionId);
  if (!sessionMeta || !sessionMeta.title || sessionMeta.title === 'Feather') {
    console.error(JSON.stringify({ error: 'missing-session-meta', sessionMeta }, null, 2));
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  try {
    await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1500);
    const rootState = await page.evaluate(() => ({
      title: document.title,
      hash: location.hash,
      landingTextPresent: document.body.innerText.includes('Open a session or create a new one'),
    }));

    await page.getByRole('button', { name: '+ New Claude' }).waitFor({ timeout: 10000 }).catch(() => {});
    await page.getByRole('button').first().click();
    await page.getByRole('button', { name: /hello old friend/i }).click({ timeout: 10000 });
    await page.waitForTimeout(1500);
    const sessionState = await page.evaluate((expectedId) => {
      const visibleText = document.body.innerText;
      return {
        title: document.title,
        hash: location.hash,
        bodyIncludesSessionTitle: visibleText.includes('hello old friend'),
        headerIncludesSessionTitle: [...document.querySelectorAll('span')].some((el) => (el.textContent || '').includes('hello old friend')),
        selectedExpectedSession: location.hash === `#${expectedId}`,
      };
    }, sessionId);

    const bugPresent =
      rootState.title === 'Feather' &&
      rootState.hash === '' &&
      rootState.landingTextPresent &&
      sessionState.title === 'Feather' &&
      sessionState.bodyIncludesSessionTitle &&
      sessionState.headerIncludesSessionTitle &&
      sessionState.selectedExpectedSession &&
      sessionMeta.title === 'hello old friend';

    console.log(JSON.stringify({
      sessionMeta,
      rootState,
      sessionState,
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
