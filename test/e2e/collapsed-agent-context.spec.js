import { test, expect } from '@playwright/test';

test('agent setup and sidecars are collapsed without hiding normal conversation', async ({ page }, testInfo) => {
  const setup = 'You are part of a Creator–Reviewer (CR) pair in Feather. Workspace: test. Private setup details.';
  const group = { id: 'pair', status: 'active', members: [{ sessionId: 'chat', role: 'creator', spawned: false }, { sessionId: 'reviewer', role: 'reviewer', spawned: true }] };
  const messages = [
    { uuid: 'setup', role: 'user', content: [{ type: 'text', text: setup }] },
    { uuid: 'user', role: 'user', content: [{ type: 'text', text: 'Please check my report.' }] },
    { uuid: 'ralph', role: 'user', content: [{ type: 'text', text: '<feather-ralph-callback event="turn_complete" iteration="3">\nContinue the Ralph loop.\n</feather-ralph-callback>' }] },
    { uuid: 'compact', role: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context. Summary details.' }] },
    { uuid: 'inbox', role: 'user', content: [{ type: 'text', text: '<pasted_content id="ab12">\nPlannotator Inbox reply on "Pick a name" (reply msg_1, thread msg_0).\n\nAnswer: Blue\n</pasted_content id="ab12">' }] },
    { uuid: 'answer', role: 'assistant', content: [{ type: 'text', text: 'Your report is ready.' }] },
  ].map(m => ({ ...m, timestamp: '2026-09-14T12:00:00Z' }));
  await page.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname;
    if (p.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': heartbeat\n\n' });
    const body = p === '/api/sessions' ? { sessions: [{ id: 'chat', title: 'Report project', agent: 'claude', updatedAt: '2026-09-14T12:00:00Z', isActive: false }] }
      : p.endsWith('/messages') ? { messages, cursor: 0, hasMore: false, nextBefore: 0 }
      : p === '/api/sidecar' ? { groups: [group] }
      : p === '/api/sidecar/pair' ? { group, thread: [{ seq: 1, from: 'reviewer', to: 'creator', text: 'Independent review details.' }] }
      : p.endsWith('/room') ? { room: null, cwd: '/projects/report' }
      : p.endsWith('/protocol-runs') ? { runs: [] }
      : p.endsWith('/btw') ? { items: [] }
      : p === '/api/rooms' ? { rooms: [] }
      : p === '/api/chat-pins' ? { pins: [], archived: [] }
      : p === '/api/agents' ? { agents: [] }
      : p === '/api/boxes' ? { boxes: [] }
      : p === '/api/sharing/peers' ? { peers: [] }
      : ['/api/quick-links', '/api/starred'].includes(p) ? [] : {};
    await route.fulfill({ json: body });
  });
  await page.goto('/#chat');
  await expect(page.getByText('Your report is ready.', { exact: true })).toBeVisible({ timeout: 12000 });
  await expect(page.getByText('Please check my report.', { exact: true })).toBeVisible();
  await expect(page.getByText(setup, { exact: true })).not.toBeVisible();
  await page.locator('summary').filter({ hasText: /Agent setup$/ }).click();
  await expect(page.getByText(setup, { exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: /Agent setup$/ }).click();
  for (const label of ['🖍️Ralph · iteration 3', '🗜️Compacted', '📬Inbox reply · Pick a name']) await expect(page.locator('summary').filter({ hasText: label })).toBeVisible();
  await expect(page.getByText('Summary details.', { exact: false })).not.toBeVisible();
  await page.locator('summary').filter({ hasText: 'Inbox reply' }).click();
  await expect(page.getByText('Answer: Blue', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  const sidecars = page.locator('summary').filter({ hasText: /^Sidecars \(1\)$/ });
  await expect(sidecars).toBeVisible();
  await expect(page.getByText('reviewer', { exact: true })).not.toBeVisible();
  await sidecars.click();
  await page.getByText('reviewer', { exact: true }).click();
  await expect(page.getByText('Independent review details.', { exact: true })).not.toBeVisible();
  await page.locator('summary').filter({ hasText: 'reviewer → creator' }).click();
  await expect(page.getByText('Independent review details.', { exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'reviewer → creator' }).click();
  await page.screenshot({ path: testInfo.outputPath('collapsed-sidecar.png'), fullPage: true });
});
