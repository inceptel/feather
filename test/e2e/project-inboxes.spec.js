import { test, expect } from '@playwright/test';

async function fixture(page, overrides = {}, getDelay = 0) {
  const project = {
    projectId: 'tic-tac-toe', sessionId: 'creator-a', title: 'Tic-tac-toe',
    objective: 'Build a playable, accessible game.', allowIdeas: true, maxGeneratedTasks: 1,
    tasks: [{ id: 'board', title: 'Playable board', status: 'reviewing', owner: 'creator-a', criteria: ['Occupied squares reject moves'], review: { verdict: 'REVISE', evidence: 'A second click overwrites X' } }],
    ...overrides,
  };
  let failNext = false;
  let savedConfig;
  let inboxRequests = 0;
  const unblockRequests = [];
  const detailRequests = [];
  await page.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname;
    let body = {};
    if (p === '/api/project-inboxes') {
      inboxRequests++;
      if (getDelay) await new Promise(resolve => setTimeout(resolve, getDelay));
      body = { projects: [{ ...project, tasks: project.tasks.map(task => ({
        id: task.id, title: task.title, owner: task.owner, status: task.status, revision: task.revision, source: task.source, updatedAt: task.updatedAt,
        blockedReason: task.status === 'blocked' ? task.history?.findLast(event => event.action === 'block')?.reason : null,
      })) }] };
    }
    else if (p === '/api/chats/creator-a/inbox/tasks') {
      if (failNext) { failNext = false; return route.fulfill({ status: 409, json: { error: 'Task already exists' } }); }
      project.tasks.push({ id: 'score', ...route.request().postDataJSON(), status: 'queued' });
      body = project;
    } else if (p === '/api/chats/creator-a/inbox/tasks/board') {
      detailRequests.push(p);
      body = project.tasks.find(task => task.id === 'board');
    } else if (p === '/api/chats/creator-a/inbox/tasks/board/unblock') {
      unblockRequests.push({ method: route.request().method(), path: p, body: route.request().postDataJSON() });
      const task = project.tasks.find(task => task.id === 'board');
      Object.assign(task, { status: 'agreeing', criteria: [], revision: null, review: null });
      task.history.push({ action: 'unblock' });
      body = task;
    } else if (p === '/api/chats/creator-a/inbox/config') {
      savedConfig = route.request().postDataJSON();
      if (typeof savedConfig.allowIdeas !== 'boolean') return route.fulfill({ status: 400, json: { error: 'Invalid project configuration' } });
      Object.assign(project, savedConfig); body = project;
    } else if (p === '/api/sessions') body = { sessions: [] };
    else if (p === '/api/scheduler') body = { enabled: true, rules: [], active: [] };
    else if (p === '/api/scheduler/runs') body = { runs: [] };
    else if (p === '/api/chat-pins') body = { pins: [], archived: [] };
    else if (p === '/api/rooms') body = { rooms: [] };
    else if (p === '/api/boxes') body = { boxes: [] };
    else if (p === '/api/sidecar') body = { groups: [] };
    else if (p === '/api/sharing/peers') body = { peers: [] };
    else if (p === '/api/agents') body = { agents: [] };
    else if (['/api/quick-links', '/api/starred'].includes(p)) body = [];
    await route.fulfill({ json: body });
  });
  await page.goto('/#autopilot');
  return { fail: () => { failNext = true; }, savedConfig: () => savedConfig, inboxRequests: () => inboxRequests, unblockRequests: () => unblockRequests,
    detailRequests: () => detailRequests, updateTask: (id, patch) => Object.assign(project.tasks.find(task => task.id === id), patch) };
}

for (const width of [1280, 390]) {
  test(`project inbox shows review and accepts work at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const state = await fixture(page);
    const inbox = page.getByRole('region', { name: 'Project inboxes' });
    await expect(inbox).toContainText('Playable board');
    await inbox.locator('summary').filter({ hasText: 'Playable board' }).click();
    await expect(inbox).toContainText('A second click overwrites X');
    await inbox.getByRole('textbox', { name: 'New task for Tic-tac-toe' }).fill('Track scores');
    await inbox.getByRole('button', { name: 'Add task', exact: true }).click();
    await expect(inbox).toContainText('Track scores');
    await expect(inbox.getByRole('textbox', { name: 'New task for Tic-tac-toe' })).toHaveValue('');
    await inbox.locator('summary').filter({ hasText: 'Project direction' }).click();
    await inbox.getByLabel('Standing objective').fill('Keep the game simple and keyboard accessible.');
    // A polling refresh must not replace text the user is editing or collapse details.
    await page.waitForTimeout(5200);
    await expect(inbox.getByLabel('Standing objective')).toHaveValue('Keep the game simple and keyboard accessible.');
    await inbox.getByRole('button', { name: 'Save direction' }).click();
    await expect.poll(() => state.savedConfig()).toEqual({ objective: 'Keep the game simple and keyboard accessible.', allowIdeas: true, maxGeneratedTasks: 1 });
    await expect(inbox).toContainText('Keep the game simple and keyboard accessible.');
    expect(await inbox.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`project-inbox-${width}.png`), fullPage: true });
  });
}

test('failed task creation keeps the draft and permits retry', async ({ page }) => {
  const state = await fixture(page);
  const inbox = page.getByRole('region', { name: 'Project inboxes' });
  state.fail();
  await inbox.getByRole('textbox', { name: 'New task for Tic-tac-toe' }).fill('Track scores');
  await inbox.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(inbox.getByRole('alert')).toHaveText('Task already exists');
  await expect(inbox.getByRole('textbox', { name: 'New task for Tic-tac-toe' })).toHaveValue('Track scores');
  await inbox.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(inbox).toContainText('Track scores');
});

test('an unconfigured inbox saves an objective with ideas disabled by default', async ({ page }) => {
  const state = await fixture(page, { objective: undefined, allowIdeas: undefined, maxGeneratedTasks: undefined });
  const inbox = page.getByRole('region', { name: 'Project inboxes' });
  await inbox.locator('summary').filter({ hasText: 'Project direction' }).click();
  await expect(inbox.getByRole('checkbox')).not.toBeChecked();
  await inbox.getByLabel('Standing objective').fill('Build a simple game.');
  await inbox.getByRole('button', { name: 'Save direction' }).click();
  await expect.poll(() => state.savedConfig()).toEqual({ objective: 'Build a simple game.', allowIdeas: false });
  await expect(inbox.getByRole('alert')).toHaveCount(0);
});

test('blocked tasks show the latest reason and unblock back into agreement', async ({ page }) => {
  const state = await fixture(page, { tasks: [{ id: 'board', title: 'Playable board', status: 'blocked', owner: 'creator-a', history: [
    { action: 'block', reason: 'Old blocker' }, { action: 'unblock' }, { action: 'block', reason: 'Need a decision on draw scoring.' },
  ] }] });
  const inbox = page.getByRole('region', { name: 'Project inboxes' });
  await expect(inbox.locator('summary').filter({ hasText: 'Playable board' })).toContainText('blocked');
  await expect(inbox.getByText('Need a decision on draw scoring.', { exact: true })).toBeVisible();
  await expect(inbox.getByText('Old blocker', { exact: true })).toHaveCount(0);
  await expect(inbox.getByRole('button', { name: 'Unblock' })).toBeVisible();
  await inbox.getByRole('button', { name: 'Unblock' }).click();
  await expect.poll(() => state.unblockRequests()).toEqual([{ method: 'POST', path: '/api/chats/creator-a/inbox/tasks/board/unblock', body: {} }]);
  await expect(inbox.locator('summary').filter({ hasText: 'Playable board' })).toContainText('agreeing');
  await expect(inbox.getByRole('button', { name: 'Unblock' })).toHaveCount(0);
  await expect(inbox.getByText('Need a decision on draw scoring.', { exact: true })).toHaveCount(0);
});

test('a response slower than the polling interval still renders without overlapping polls', async ({ page }) => {
  const state = await fixture(page, {}, 6200);
  const inbox = page.getByRole('region', { name: 'Project inboxes' });
  await expect(inbox).toContainText('Playable board', { timeout: 10000 });
  expect(state.inboxRequests()).toBe(1);
});

test('task details load only when opened and refresh when its reviewed revision changes', async ({ page }) => {
  const state = await fixture(page);
  const inbox = page.getByRole('region', { name: 'Project inboxes' });
  const summary = inbox.locator('summary').filter({ hasText: 'Playable board' });
  await expect(summary).toBeVisible();
  expect(state.detailRequests()).toEqual([]);
  await summary.click();
  await expect(inbox).toContainText('A second click overwrites X');
  expect(state.detailRequests()).toHaveLength(1);
  await page.waitForTimeout(5200);
  expect(state.detailRequests()).toHaveLength(1);
  await inbox.getByRole('textbox', { name: 'New task for Tic-tac-toe' }).fill('Keep this draft');
  state.updateTask('board', { status: 'approved', revision: 'commit-two', review: { verdict: 'PASS', evidence: 'Repeated clicks preserve X and the next turn.' } });
  await expect(inbox).toContainText('Repeated clicks preserve X and the next turn.', { timeout: 10000 });
  expect(state.detailRequests()).toHaveLength(2);
  await expect(summary.locator('..')).toHaveAttribute('open', '');
  await expect(inbox.getByRole('textbox', { name: 'New task for Tic-tac-toe' })).toHaveValue('Keep this draft');
  state.updateTask('board', { updatedAt: '2026-09-14T12:00:00.000Z', criteria: ['Updated success criteria'] });
  await expect(inbox).toContainText('Updated success criteria', { timeout: 10000 });
  expect(state.detailRequests()).toHaveLength(3);
  await summary.click();
  state.updateTask('board', { status: 'done' });
  await expect(summary).toContainText('done', { timeout: 10000 });
  expect(state.detailRequests()).toHaveLength(3);
});
