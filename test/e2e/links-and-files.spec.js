import { test, expect } from '@playwright/test';

async function fixture(page, text, hash = 'links') {
  await page.route('**/api/**', async route => {
    const u = new URL(route.request().url()), p = u.pathname;
    if (p.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': heartbeat\n\n' });
    if (p === '/api/file' && u.searchParams.get('path').endsWith('chart.png')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180"><rect width="480" height="180" fill="#182d32"/><path d="M25 145L130 110L240 130L350 50L455 25" fill="none" stroke="#4aba6a" stroke-width="4"/></svg>' });
    if (p === '/api/file') return route.fulfill({ contentType: 'text/plain', body: u.searchParams.get('path').endsWith('empty.txt') ? '' : '# File preview\n\nA readable report, with working links and images from the same project folder.\n\n[Next](next.md)\n\n![Chart](chart.png)' });
    if (p === '/api/files') return route.fulfill({ status: 400, json: { error: 'not a directory' } });
    const body = p === '/api/sessions' ? { sessions: [{ id: 'links', title: 'Link test', agent: 'claude', updatedAt: new Date().toISOString(), isActive: false }] }
      : p.endsWith('/messages') ? { messages: [{ uuid: 'answer', role: 'assistant', timestamp: new Date().toISOString(), content: [{ type: 'text', text }] }], cursor: 0, hasMore: false, nextBefore: 0 }
      : p.endsWith('/room') ? { room: null, cwd: '/projects/boat' }
      : p.endsWith('/protocol-runs') ? { runs: [] }
      : p.endsWith('/btw') ? { items: [] }
      : p === '/api/rooms' ? { rooms: [] }
      : p === '/api/chat-pins' ? { pins: [], archived: [] }
      : p === '/api/agents' ? { agents: [] }
      : p === '/api/boxes' ? { boxes: [] }
      : p === '/api/sidecar' ? { groups: [] }
      : p === '/api/sharing/peers' ? { peers: [] }
      : ['/api/quick-links', '/api/starred'].includes(p) ? [] : {};
    await route.fulfill({ json: body });
  });
  await page.goto('/#' + hash);
  await expect(page.locator('[data-testid="chat-panel"] .markdown').first()).toBeVisible({ timeout: 12000 });
}

test('HTML file links survive sanitization and open a useful preview', async ({ page }, testInfo) => {
  await fixture(page, '<a href="file:///projects/boat/My%20Report.md">click here</a>');
  await page.getByRole('link', { name: 'click here', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'File preview' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('/projects/boat/My Report.md');
  await expect(dialog.getByRole('heading', { name: 'File preview' })).toBeVisible();
  await expect(dialog.locator('img')).toHaveAttribute('src', /path=%2Fprojects%2Fboat%2Fchart.png/);
  await page.screenshot({ path: testInfo.outputPath('markdown-preview.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(dialog.locator('pre')).toContainText('# File preview');
});

test('relative HTML anchors resolve from workspace and empty files finish loading', async ({ page }) => {
  await fixture(page, '<a href="empty.txt">Empty file</a>');
  await page.getByRole('link', { name: 'Empty file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'File preview' });
  await expect(dialog).toContainText('/projects/boat/empty.txt');
  await expect(dialog).toContainText('This file is empty.');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('Wiki and Files are workspace controls, not chat tabs', async ({ page }) => {
  await fixture(page, 'Hello');
  const tabs = page.getByRole('navigation', { name: 'Conversation views' });
  await expect(tabs.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
  await expect(tabs.getByRole('button', { name: /Wiki|Files/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open sidebar' }).click();
  const workspace = page.getByRole('navigation', { name: 'Workspace' });
  await expect(workspace.getByRole('button', { name: 'Wiki', exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Files', exact: true })).toBeVisible();
});

test('HTML preview is isolated and cannot execute scripts', async ({ page }, testInfo) => {
  await fixture(page, '[HTML report](/projects/boat/report.html)');
  await page.route('**/api/file?**', route => route.fulfill({ contentType: 'text/html', body: '<style>h1 { color: teal }</style><h1>Boat report</h1><script>parent.document.body.innerHTML="PWNED"</script><img src="https://example.com/track">' }));
  await page.getByRole('link', { name: 'HTML report' }).click();
  const frame = page.getByTitle('HTML preview');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('iframe[title="HTML preview"]').getByRole('heading', { name: 'Boat report' })).toBeVisible();
  await expect(page.frameLocator('iframe[title="HTML preview"]').getByRole('heading', { name: 'Boat report' })).toHaveCSS('color', 'rgb(0, 128, 128)');
  expect(await frame.getAttribute('srcdoc')).not.toContain('<script');
  expect(await frame.getAttribute('srcdoc')).not.toContain('https://example.com/track');
  await expect(page.getByRole('dialog', { name: 'File preview' })).toContainText('scripts disabled');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('html-preview-mobile.png'), fullPage: true });
});

test('closing a loading preview cannot reopen it', async ({ page }) => {
  await fixture(page, '[Slow file](/projects/boat/slow.txt)');
  let pending;
  await page.route('**/api/file?**', route => { pending = route; });
  await page.getByRole('link', { name: 'Slow file' }).click();
  await expect(page.getByRole('dialog', { name: 'File preview' })).toBeVisible();
  await expect.poll(() => !!pending).toBe(true);
  await page.getByRole('button', { name: 'Close file preview' }).click();
  await pending.fulfill({ body: 'Late answer' }).catch(() => {});
  await page.waitForTimeout(100);
  await expect(page.getByRole('dialog', { name: 'File preview' })).toHaveCount(0);
});

test('safe web links work and executable links remain inert', async ({ page }) => {
  await fixture(page, '<a href="https://example.com/report">Web report</a>\n\n<a href="javascript:alert(1)">Unsafe</a>\n\n<a href="javascript%3Aalert(1)">Encoded unsafe</a>\n\n<a href="/api/file?path=javascript%3Aalert(1)">Disguised unsafe</a>\n\n[Sandbox file](sandbox:/mnt/data/report.md)');
  const web = page.getByRole('link', { name: 'Web report' });
  await expect(web).toHaveAttribute('href', 'https://example.com/report');
  await expect(web).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('.markdown a', { hasText: /^Unsafe$/ })).not.toHaveAttribute('href');
  await expect(page.locator('.markdown a', { hasText: 'Encoded unsafe' })).not.toHaveAttribute('href');
  await expect(page.locator('.markdown a', { hasText: 'Disguised unsafe' })).not.toHaveAttribute('href');
  await page.getByRole('link', { name: 'Sandbox file' }).click();
  await expect(page.getByRole('dialog', { name: 'File preview' })).toContainText('/mnt/data/report.md');
});

test('remote file links never read the owner machine', async ({ page }) => {
  let reads = 0;
  page.on('request', request => { if (/\/api\/files?\?/.test(request.url())) reads++; });
  await fixture(page, '[Remote file](/projects/boat/secrets.txt)', 'remote:links');
  await page.getByRole('link', { name: 'Remote file' }).click();
  await expect(page.getByRole('alert')).toContainText('own Feather instance');
  expect(reads).toBe(0);
});

test('document anchors stay inside the chat and do not change the session route', async ({ page }) => {
  await fixture(page, '[Jump to details](#details)\n\n## Details\n\nThe answer.');
  await page.getByRole('link', { name: 'Jump to details' }).click();
  await expect(page).toHaveURL(/#links$/);
  await expect(page.getByRole('heading', { name: 'Details' })).toHaveAttribute('id', 'details');
});
