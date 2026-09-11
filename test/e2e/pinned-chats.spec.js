import { test, expect } from '@playwright/test';

for (const width of [1280, 390]) {
  test(`chat home, Wiki and Autopilot at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let pins = [{ id: 'boat', title: 'Boat' }], archived = [];
    const sessions = [
      { id: 'boat', title: 'Boat', agent: 'claude', chatRole: 'creator', chatPair: { groupId: 'boat-pair', creatorSessionId: 'boat', reviewerSessionId: 'boat-reviewer' }, updatedAt: new Date().toISOString(), isActive: false },
      { id: 'ev', title: 'Jacksonville EV', agent: 'claude', updatedAt: new Date().toISOString(), isActive: true, mode: 'ralph', ralph: { enabled: true, status: 'working', iteration: 2 } },
    ];
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const p = url.pathname;
      let body = {};
      if (p === '/api/sessions') body = { sessions: url.searchParams.get('mode') ? sessions.filter(s => s.mode === 'ralph') : sessions };
      else if (p.endsWith('/messages')) body = { messages: [], hasMore: false, cursor: 0, nextBefore: 0 };
      else if (p.endsWith('/protocol-runs')) body = { runs: [] };
      else if (p.endsWith('/room')) body = { room: null };
      else if (p.endsWith('/btw')) body = { items: [] };
      else if (p.endsWith('/stream')) { await route.fulfill({ contentType: 'text/event-stream', body: ': heartbeat\n\n' }); return; }
      else if (p === '/api/chats') {
        const input = route.request().postDataJSON();
        expect(input.projectSessionId).toBe('boat');
        expect(input.name).toBe('Strategy B');
        sessions.push({ ...sessions[0], id: 'boat-b', title: 'Strategy B' });
        body = { id: 'boat-b' };
      }
      else if (p === '/api/chats/boat/project/rename') {
        expect(route.request().postDataJSON().name).toBe('Boating');
        body = { cwd: '/projects/boating' };
      }
      else if (p === '/api/rooms') body = { rooms: [] };
      else if (p === '/api/chat-pins' || p.startsWith('/api/chat-pins/')) {
        if (route.request().method() === 'POST') {
          const input = route.request().postDataJSON();
          input.id = decodeURIComponent(p.split('/').at(-1));
          if ('pinned' in input) pins = input.pinned ? [...pins, { id: input.id }] : pins.filter(p => p.id !== input.id);
          if ('archived' in input) archived = input.archived ? [...archived, input.id] : archived.filter(id => id !== input.id);
        }
        body = { pins: pins.filter(p => !archived.includes(p.id)), archived };
      }
      else if (p === '/api/wiki') body = { pages: [{ source: 'shared', name: 'Home', size: 40, updatedAt: new Date().toISOString() }] };
      else if (p === '/api/wiki/page') body = { content: '# Shared knowledge\n\nReviewed notes from your chats.' };
      else if (p === '/api/scheduler') body = { rules: [], enabled: true, active: [] };
      else if (p === '/api/scheduler/runs') body = { runs: [] };
      else if (p === '/api/scheduler/chats/ev/stop') { sessions[1].ralph.enabled = false; sessions[1].ralph.status = 'stopped'; body = { ok: true }; }
      else if (p === '/api/agents') body = { agents: [] };
      else if (p === '/api/boxes') body = { boxes: [] };
      else if (p === '/api/sidecar') body = { groups: [] };
      else if (p === '/api/sharing/peers') body = { peers: [] };
      else if (p === '/api/quick-links' || p === '/api/starred') body = [];
      else if (p === '/api/feed') body = { items: [{ evidenceId: 'chat:boat:1', sourceKind: 'chat', kind: 'update', room: 'Boat', title: 'Battery comparison ready', summary: 'Reviewed two options.', occurredAt: new Date().toISOString(), sourceHref: '/#boat', sourceState: 'available', needsReview: false, sessionId: 'boat' }], following: [], cursor: '1' };
      await route.fulfill({ json: body });
    });
    await page.goto('/#');
    await expect(page.getByRole('region', { name: 'Pinned chats', exact: true })).toContainText('Boat');
    await page.getByRole('button', { name: 'Pin Jacksonville EV', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Pinned chats', exact: true })).toContainText('Jacksonville EV');
    await page.getByRole('button', { name: 'Archive Jacksonville EV', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Show archived chats' }).check();
    await expect(page.getByRole('region', { name: 'Archived chats', exact: true })).toContainText('Jacksonville EV');
    await page.getByRole('button', { name: 'Restore Jacksonville EV', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Archived chats', exact: true })).not.toContainText('Jacksonville EV');
    await page.reload();
    await expect(page.getByRole('region', { name: 'Pinned chats', exact: true })).toContainText('Jacksonville EV');
    await page.screenshot({ path: testInfo.outputPath('chats.png'), fullPage: true });
    await page.getByTestId('home-nav').getByRole('button', { name: 'Wiki', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Shared knowledge' })).toBeVisible();
    await page.getByTestId('home-nav').getByRole('button', { name: 'Updates', exact: true }).click();
    await expect(page.getByText('Battery comparison ready')).toBeVisible();
    await page.getByTestId('home-nav-scheduler').click();
    await expect(page.getByTestId('scheduler-view')).toContainText('Jacksonville EV');
    await page.getByTestId('scheduler-view').getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByTestId('scheduler-view')).toContainText('stopped');
    await page.screenshot({ path: testInfo.outputPath('autopilot.png'), fullPage: true });
    await page.getByTestId('home-nav').getByRole('button', { name: 'Updates', exact: true }).click();
    await page.getByRole('link', { name: 'Open chat →' }).click();
    await expect(page).toHaveURL(/#boat$/);
    await page.getByRole('button', { name: '⋮', exact: true }).click();
    page.once('dialog', dialog => dialog.accept('Boating'));
    const renamed = page.waitForRequest(request => request.url().endsWith('/api/chats/boat/project/rename'));
    await page.getByTestId('rename-project').click();
    await renamed;
    await page.getByRole('button', { name: '⋮', exact: true }).click();
    page.once('dialog', dialog => dialog.accept('Strategy B'));
    await page.getByTestId('new-project-chat').click();
    await expect(page).toHaveURL(/#boat-b$/);
    expect(errors).toEqual([]);
  });
}
