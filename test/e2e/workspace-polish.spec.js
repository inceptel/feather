import { test, expect } from '@playwright/test';

test('pinned and recent chats sort newest activity first', async ({ page }) => {
  const sessions = [
    { id: 'old-pin', title: 'Older pin', updatedAt: '2026-09-01T00:00:00Z' },
    { id: 'old', title: 'Older chat', updatedAt: '2026-09-02T00:00:00Z' },
    { id: 'new-pin', title: 'Newer pin', updatedAt: '2026-09-10T00:00:00Z' },
    { id: 'new', title: 'Newer chat', updatedAt: '2026-09-11T00:00:00Z' },
  ];
  await page.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname;
    const body = p === '/api/sessions' ? { sessions }
      : p === '/api/chat-pins' ? { pins: [{ id: 'old-pin' }, { id: 'new-pin' }], archived: [] }
      : p === '/api/rooms' ? { rooms: [] }
      : p === '/api/boxes' ? { boxes: [] }
      : p === '/api/sidecar' ? { groups: [] }
      : p === '/api/sharing/peers' ? { peers: [] }
      : p === '/api/agents' ? { agents: [] }
      : ['/api/quick-links', '/api/starred'].includes(p) ? [] : {};
    await route.fulfill({ json: body });
  });
  await page.goto('/#');
  await expect(page.getByRole('region', { name: 'Pinned chats', exact: true }).locator('.chat-home-title')).toHaveText(['Newer pin', 'Older pin']);
  await expect(page.getByRole('region', { name: 'Recent chats', exact: true }).locator('.chat-home-title')).toHaveText(['Newer chat', 'Older chat']);
});

for (const theme of ['feather', 'opencode', 'catppuccin', 'tokyonight']) {
  test(`workspace respects ${theme} theme and narrow layouts`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(value => localStorage.setItem('feather-theme', value), theme);
    const session = { id: 'long-title', title: 'Boat maintenance and equipment research for next season — detailed comparison', agent: 'claude', updatedAt: '2026-09-11T12:00:00Z', isActive: false, projectLabel: '/projects/boat-maintenance-and-equipment-research' };
    await page.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname;
      const body = p === '/api/sessions' ? { sessions: [session] }
        : p === '/api/chat-pins' ? { pins: [{ id: session.id }], archived: [] }
        : p === '/api/rooms' ? { rooms: [] }
        : p === '/api/boxes' ? { boxes: [] }
        : p === '/api/sidecar' ? { groups: [] }
        : p === '/api/sharing/peers' ? { peers: [] }
        : p === '/api/agents' ? { agents: [] }
        : ['/api/quick-links', '/api/starred'].includes(p) ? [] : {};
      await route.fulfill({ json: body });
    });
    await page.goto('/#');
    const home = page.getByTestId('chats-home');
    await expect(home).toContainText(session.title);
    expect(await home.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const background = await home.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(background).toBe(await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor));
    await page.getByRole('button', { name: `Unpin ${session.title}`, exact: true }).focus();
    expect(await page.getByRole('button', { name: `Unpin ${session.title}`, exact: true }).evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
    await page.getByRole('button', { name: `Unpin ${session.title}`, exact: true }).blur();
    await page.screenshot({ path: testInfo.outputPath(`${theme}-mobile.png`), fullPage: true });
    await page.setViewportSize({ width: 320, height: 740 });
    expect(await home.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const costs = page.getByTestId('home-nav').getByRole('button', { name: 'Costs', exact: true });
    await costs.scrollIntoViewIfNeeded();
    const bounds = await costs.boundingBox();
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  });
}
