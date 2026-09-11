import { test, expect } from '@playwright/test';

for (const refreshFails of [false, true]) {
  test(`newer Wiki selection survives delayed index ${refreshFails ? 'failure' : 'refresh'}`, async ({ page }) => {
    let indexRequests = 0;
    let pendingIndex;
    const pages = ['Home', 'Boat'].map(name => ({ source: 'shared', name, size: 20, updatedAt: '2026-09-11T12:00:00Z' }));
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let body = {};
      if (url.pathname === '/api/wiki') {
        if (++indexRequests === 2) { pendingIndex = route; return; }
        body = { pages };
      } else if (url.pathname === '/api/wiki/page') body = { content: `# ${url.searchParams.get('name')} knowledge` };
      else if (url.pathname === '/api/rooms') body = { rooms: [] };
      else if (url.pathname === '/api/sessions') body = { sessions: [] };
      else if (url.pathname === '/api/chat-pins') body = { pins: [], archived: [] };
      else if (url.pathname === '/api/boxes') body = { boxes: [] };
      else if (url.pathname === '/api/sidecar') body = { groups: [] };
      else if (url.pathname === '/api/sharing/peers') body = { peers: [] };
      else if (url.pathname === '/api/agents') body = { agents: [] };
      else if (['/api/quick-links', '/api/starred'].includes(url.pathname)) body = [];
      await route.fulfill({ json: body });
    });
    await page.goto('/#wiki');
    await expect(page.getByRole('heading', { name: 'Home knowledge' })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(() => !!pendingIndex).toBe(true);
    await page.getByRole('navigation', { name: 'Wiki pages' }).getByRole('button', { name: 'Boat Shared wiki' }).click();
    await expect(page.getByRole('heading', { name: 'Boat knowledge' })).toBeVisible();
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/wiki');
    await pendingIndex.fulfill(refreshFails
      ? { status: 500, json: { error: 'Delayed index failure' } }
      : { json: { pages: [...pages, { ...pages[0], name: 'Added' }] } });
    await refreshed;
    if (!refreshFails) await expect(page.getByRole('button', { name: 'Added Shared wiki' })).toBeVisible();
    // Drain response handlers before checking that stale index errors did not win.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole('heading', { name: 'Boat knowledge' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Boat Shared wiki' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}
