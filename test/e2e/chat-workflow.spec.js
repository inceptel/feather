import { test, expect } from '@playwright/test';

for (const width of [1280, 390]) {
  test(`editable startup, retry and same-chat work at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    // Keep the synthetic stream open: route.fulfill would close a real SSE
    // response immediately and manufacture an unrelated reconnect warning.
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
        readyState = 1;
        constructor(url) {
          super(); this.url = String(url);
          setTimeout(() => { if (this.readyState === 1) this.dispatchEvent(new MessageEvent('connected', { data: '{}' })); }, 0);
        }
        close() { this.readyState = 2; }
      };
    });
    const errors = [], creations = [], sends = [];
    page.on('pageerror', error => errors.push(error.message));
    let releaseCreation;
    const creationGate = new Promise(resolve => { releaseCreation = resolve; });
    let attempts = 0, startupStatus = 'starting';
    let activeStatusRequests = 0, maxStatusRequests = 0, statusRequests = 0;
    let workflowStarts = 0;
    const sessions = [];
    await page.route('**/api/**', async route => {
      const p = new URL(route.request().url()).pathname;
      let body = {};
      if (p === '/api/chats') {
        creations.push(route.request().postDataJSON());
        attempts++;
        if (attempts === 1) {
          await creationGate;
          await route.abort('failed');
          return;
        }
        if (!sessions.length) sessions.push({ id: 'test-chat', title: 'New chat', chatRole: 'creator', isActive: true, updatedAt: new Date().toISOString(), chatStartup: { status: 'starting' } });
        sessions[0].chatStartup.status = 'starting';
        body = { id: 'test-chat', status: 'starting' };
      } else if (p === '/api/chats/test-chat/status') {
        activeStatusRequests++;
        maxStatusRequests = Math.max(maxStatusRequests, activeStatusRequests);
        if (++statusRequests === 1) await new Promise(resolve => setTimeout(resolve, 1800));
        body = { id: 'test-chat', status: startupStatus };
        sessions[0].chatStartup.status = body.status;
        activeStatusRequests--;
      } else if (p === '/api/sessions/test-chat/workflow') {
        expect(route.request().postDataJSON()).toEqual({ action: 'start' });
        sessions[0].workflow = { enabled: true, phase: 'reviewing', generation: 0, objective: 'Compare the sample options', summary: 'Comparison drafted; checking evidence.', evidence: 'comparison.md', next: 'Resolve reviewer comments', updatedAt: new Date().toISOString() };
        if (width === 390) sessions[0].workflow.summary += ' The comparison includes capacity, cost, and installation constraints for each sample option, with the supporting calculations retained for independent review.';
        if (++workflowStarts === 1) sessions[0].workflow = { enabled: false, pendingStart: true, phase: 'waiting', generation: 0 };
        body = { workflow: sessions[0].workflow };
      } else if (p === '/api/sessions/test-chat/ralph') {
        expect(route.request().postDataJSON()).toEqual({ enabled: false });
        sessions[0].workflow = { ...sessions[0].workflow, enabled: false, pendingStart: false, phase: 'stopped' };
        body = { ok: true };
      } else if (p === '/api/chats/test-chat/reviewer') {
        if (route.request().method() === 'POST') {
          expect(route.request().postDataJSON()).toEqual({ reviewPolicy: 'adaptive' });
          sessions[0].chatPair = { groupId: 'g1', creatorSessionId: 'test-chat', reviewerSessionId: 'test-reviewer' };
          sessions[0].reviewPolicy = 'adaptive';
          body = { attached: true, chatPair: sessions[0].chatPair, reviewPolicy: 'adaptive' };
        } else {
          expect(route.request().method()).toBe('DELETE');
          sessions[0].chatPair = null; sessions[0].reviewPolicy = 'none';
          body = { detached: true, chatPair: null, reviewPolicy: 'none' };
        }
      } else if (p.endsWith('/input')) { sends.push(route.request().postDataJSON()); body = { ok: true }; }
      else if (p === '/api/sessions') body = { sessions };
      else if (p.endsWith('/messages')) body = { messages: [], hasMore: false, cursor: 0, nextBefore: 0 };
      else if (p.endsWith('/protocol-runs')) body = { runs: [] };
      else if (p.endsWith('/btw')) body = { items: [] };
      else if (p.endsWith('/room')) body = { room: null };
      else if (p.endsWith('/stream')) { await route.fulfill({ contentType: 'text/event-stream', body: 'event: connected\ndata: {}\n\n: heartbeat\n\n' }); return; }
      else if (p === '/api/chat-pins') body = { pins: [], archived: [] };
      else if (p === '/api/rooms') body = { rooms: [] };
      else if (p === '/api/agents') body = { agents: [] };
      else if (p === '/api/boxes') body = { boxes: [] };
      else if (p === '/api/sidecar') body = { groups: [] };
      else if (p === '/api/sharing/peers') body = { peers: [] };
      else if (p === '/api/quick-links' || p === '/api/starred') body = [];
      await route.fulfill({ json: body });
    });
    await page.goto('/#');
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const editor = page.locator('textarea').first();
    await expect(editor).toBeEditable();
    await editor.fill('Compare the sample options');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath(`startup-${width}.png`), fullPage: true });
    releaseCreation();
    await expect(page.getByRole('button', { name: 'Retry startup', exact: true })).toBeVisible();
    await page.reload();
    await expect(editor).toHaveValue('Compare the sample options');
    await expect.poll(() => editor.evaluate(el => el.scrollHeight <= el.clientHeight + 2)).toBe(true);
    await page.getByRole('button', { name: 'Retry startup', exact: true }).click();
    await expect(page).toHaveURL(/#test-chat$/);
    await expect(editor).toHaveValue('Compare the sample options');
    expect(creations[0].agent).toBeUndefined();
    expect(creations[1].requestId).toBe(creations[0].requestId);
    await editor.press('Enter');
    expect(sends).toHaveLength(0);
    startupStatus = 'failed';
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.poll(() => creations.length).toBe(3);
    expect(creations[2].requestId).not.toBe(creations[1].requestId);
    await expect(editor).toHaveValue('Compare the sample options');
    startupStatus = 'ready';
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    // The old progress banner is gone: no region between the header and the tabs.
    await expect(page.getByRole('region', { name: 'Chat startup' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Chat progress' })).toHaveCount(0);
    await expect(page.getByText('Details & evidence', { exact: true })).toHaveCount(0);
    const tabs = page.getByRole('navigation', { name: 'Conversation views' });
    await expect(tabs).toBeVisible();
    const menu = page.getByTestId('chat-menu');
    const toggleWorking = page.getByTestId('toggle-working');
    const toggleReviewer = page.getByTestId('toggle-reviewer');
    await menu.click();
    await expect(toggleWorking).toHaveText('Keep working');
    await expect(toggleReviewer).toHaveText('Attach reviewer');
    await toggleWorking.click();
    await expect(toggleWorking).toBeHidden();
    await expect.poll(() => workflowStarts).toBe(1);
    await menu.click();
    await expect(toggleWorking).toHaveText('Stop working');
    await toggleWorking.click();
    await menu.click();
    await expect(toggleWorking).toHaveText('Keep working');
    await toggleWorking.click();
    await expect.poll(() => workflowStarts).toBe(2);
    await expect(page.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();
    await expect(page.getByText('Loading...', { exact: true })).toBeHidden();
    await expect(page.getByText('Reconnecting...', { exact: true })).toBeHidden();
    await menu.click();
    await expect(toggleWorking).toHaveText('Stop working');
    await toggleReviewer.click();
    await menu.click();
    await expect(toggleReviewer).toHaveText('Detach reviewer');
    await toggleReviewer.click();
    await menu.click();
    await expect(toggleReviewer).toHaveText('Attach reviewer');
    await page.keyboard.press('Escape');
    const bounds = await editor.boundingBox();
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // The tabs sit directly under the chat header: nothing but the header above them.
    const tabsBox = await tabs.boundingBox();
    const headerBottom = await page.getByTestId('chat-menu').evaluate(el => el.closest('header, [data-testid="chat-header"]')?.getBoundingClientRect().bottom ?? 0);
    if (headerBottom) expect(tabsBox.y).toBeLessThanOrEqual(headerBottom + 2);
    await page.screenshot({ path: testInfo.outputPath(`working-${width}.png`), fullPage: true });
    expect(creations).toHaveLength(3);
    expect(maxStatusRequests).toBe(1);
    expect(errors).toEqual([]);
  });
}
