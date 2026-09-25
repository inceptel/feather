import { test, expect } from '@playwright/test';

const SESSION = { id: 'startup-route-fixture', title: 'Restored chat', isActive: false, agent: 'omp', updatedAt: '2026-09-01T00:00:00Z' };
const HOME = '[data-testid="home-nav"], [data-testid="chats-home"], [data-testid="rooms-home"]';

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(page) {
  const state = { sessionsGate: null, boxesGate: null, failSessions: false, failBoxes: false, mutations: [], sessionBoxes: [] };
  await page.addInitScript(homeSelector => {
    window.homeMounted = false;
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(homeSelector) || node.querySelector(homeSelector))) window.homeMounted = true;
        }
      }
    }).observe(document, { childList: true, subtree: true });
    // A synthetic open stream avoids manufacturing SSE reconnection failures.
    window.EventSource = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
      readyState = 1;
      constructor(url) {
        super(); this.url = String(url);
        setTimeout(() => { if (this.readyState === 1) this.dispatchEvent(new MessageEvent('connected', { data: '{}' })); }, 0);
      }
      close() { this.readyState = 2; }
    };
  }, HOME);
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) {
      state.mutations.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 405, json: { error: 'No mutations in this fixture' } });
    }
    const p = url.pathname;
    if (!p.startsWith('/api/')) return route.continue();
    let body;
    if (p === '/api/sessions') {
      state.sessionBoxes.push(url.searchParams.get('box') || 'local');
      if (state.sessionsGate) await state.sessionsGate.promise;
      if (state.failSessions) return route.abort('failed');
      body = { sessions: [SESSION], control: false };
    } else if (p === '/api/boxes') {
      if (state.boxesGate) await state.boxesGate.promise;
      if (state.failBoxes) return route.abort('failed');
      body = { boxes: [{ id: 'local', label: 'Local', available: true }, { id: 'fixture-peer', label: 'Fixture peer', peer: true, available: true }] };
    } else if (p.endsWith('/messages')) body = { messages: [], hasMore: false, cursor: 0, nextBefore: 0 };
    else if (p.endsWith('/protocol-runs')) body = { runs: [] };
    else if (p.endsWith('/btw')) body = { items: [] };
    else if (p.endsWith('/room')) body = { room: null };
    else if (p === '/api/chat-pins') body = { pins: [], archived: [] };
    else if (p === '/api/rooms') body = { rooms: [] };
    else if (p === '/api/agents') body = { agents: [] };
    else if (p === '/api/sidecar') body = { groups: [] };
    else if (p === '/api/sharing/peers') body = { peers: [] };
    else if (p === '/api/quick-links' || p === '/api/starred') body = [];
    // All other API calls (including launches and version checks) stay local.
    else return route.fulfill({ status: 404, json: { error: 'Fixture route not provided' } });
    return route.fulfill({ json: body });
  });
  return state;
}

test('reload restores the chat URL and draft without mounting home during delayed sessions', async ({ page }, testInfo) => {
  const state = await fixture(page);
  await page.goto(`/#${SESSION.id}`);
  const composer = page.locator('textarea[placeholder="Send a message..."]');
  await expect(composer).toBeEditable();
  await composer.fill('Keep this unsent draft through reload');
  const url = page.url();
  const delay = state.sessionsGate = gate();
  const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/sessions');
  try {
    await page.reload();
    await request;
    await expect(page.locator(HOME)).toHaveCount(0);
    expect(await page.evaluate(() => window.homeMounted)).toBe(false);
    await expect(page.getByRole('status', { name: 'Restoring view' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('restoring-chat.png') });
  } finally {
    state.sessionsGate = null;
    delay.release();
  }
  await expect(page).toHaveURL(url);
  await expect(composer).toHaveValue('Keep this unsent draft through reload');
  await expect(page.getByRole('status', { name: 'Restoring view' })).toHaveCount(0);
  expect(await page.evaluate(() => window.homeMounted)).toBe(false);
  expect(state.mutations).toEqual([]);
});

test('peer restoration waits for boxes and preserves view-only routing', async ({ page }) => {
  const state = await fixture(page);
  const delay = state.boxesGate = gate();
  try {
    await page.goto(`/#fixture-peer:${SESSION.id}`);
    await expect(page.getByRole('status', { name: 'Restoring view' })).toBeVisible();
    await expect(page.locator(HOME)).toHaveCount(0);
    await expect(page.locator('textarea')).toHaveCount(0);
  } finally {
    state.boxesGate = null;
    delay.release();
  }
  await expect(page.getByText(/View only — Fixture peer/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#fixture-peer:${SESSION.id}$`));
  await expect(page.locator('textarea')).toHaveCount(0);
  expect(state.sessionBoxes).toEqual(['fixture-peer']);
  expect(await page.evaluate(() => window.homeMounted)).toBe(false);
  expect(state.mutations).toEqual([]);
});

test('home navigation during peer startup wins over the initial destination', async ({ page }) => {
  const state = await fixture(page);
  const delay = state.sessionsGate = gate();
  const request = page.waitForRequest(request => new URL(request.url()).pathname === '/api/sessions');
  try {
    await page.goto(`/#fixture-peer:${SESSION.id}`);
    await request;
    await page.evaluate(() => { location.hash = 'costs'; });
  } finally {
    state.sessionsGate = null;
    delay.release();
  }
  await expect(page).toHaveURL(/#costs$/);
  await expect(page.getByTestId('costs-view')).toBeVisible();
  await expect(page.locator('textarea')).toHaveCount(0);
  await page.evaluate(() => { location.hash = ''; });
  await expect(page.getByTestId('chats-home')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Restoring view' })).toHaveCount(0);
  expect(state.mutations).toEqual([]);
});

test('failed startup requests do not strand a chat or empty-hash home', async ({ page }) => {
  const state = await fixture(page);
  state.failSessions = true;
  state.failBoxes = true;
  await page.goto(`/#${SESSION.id}`);
  await expect(page.locator('textarea[placeholder="Send a message..."]')).toBeEditable();
  await expect(page.getByRole('status', { name: 'Restoring view' })).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByTestId('chats-home')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Restoring view' })).toHaveCount(0);
  expect(state.mutations).toEqual([]);
});
