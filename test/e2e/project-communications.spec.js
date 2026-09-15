import { test, expect } from '@playwright/test';

async function fixture(page, hash = 'updates', options = {}) {
  const item = { sourceKind: 'project', projectId: 'example-game', evidenceId: 'project-update:morning', kind: 'update', room: 'Example Game', title: 'Your opponents play smarter', summary: 'Rivals now respond to inventory pressure. Try another round.', detail: null, occurredAt: new Date().toISOString(), sourceHref: '/#session/creator', sourceState: 'available', status: null, needsReview: false, sessionId: 'creator', comments: [] };
  const comms = { enabled: true, jobs: [{ id: 'failed-job', role: 'marketer', projectId: 'example-game', projectTitle: 'Example Game', status: 'stalled', error: 'Session disconnected', sessionId: 'writer' }, { id: 'wiki-job', role: 'caretaker', projectId: 'example-game', projectTitle: 'Example Game', status: 'running', sessionId: 'keeper' }] };
  const actions = [], comments = [], steers = [];
  let failComment = false, failAction = false;
  let commsRequests = 0;
  await page.route('**/api/**', async route => {
    const p = new URL(route.request().url()).pathname;
    let body = {};
    if (p === '/api/feed') body = { items: [item], following: [], cursor: 'one', generatedAt: new Date().toISOString() };
    else if (p === '/api/feed/comments') {
      if (failComment) { failComment = false; return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }); }
      comments.push(route.request().postDataJSON());
      const comment = { id: 'comment-one', ...comments.at(-1), room: item.room, createdAt: new Date().toISOString(), status: 'queued', reply: null };
      item.comments.push(comment); body = { ok: true, comment };
    } else if (p === '/api/project-comms') {
      if (route.request().method() === 'GET') { commsRequests++; if (options.waitForComms) await options.waitForComms; }
      if (route.request().method() === 'POST') {
        if (failAction) { failAction = false; return route.fulfill({ status: 503, json: { error: 'Could not save' } }); }
        const action = route.request().postDataJSON(); actions.push(action);
        if (action.action === 'pause') comms.enabled = false;
        if (action.action === 'resume') comms.enabled = true;
        if (action.action === 'retry') Object.assign(comms.jobs.find(job => job.id === action.jobId), { status: 'queued', error: null });
      }
      body = comms;
    } else if (p.endsWith('/steer')) steers.push(p);
    else if (p === '/api/project-inboxes') body = { projects: [] };
    else if (p === '/api/research-subscriptions') body = { subscriptions: [] };
    else if (p === '/api/sessions') body = { sessions: [] };
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
  await page.goto(`/#${hash}`);
  return { item, comms, commsRequests: () => commsRequests, actions, comments, steers, failComment: () => { failComment = true; }, failAction: () => { failAction = true; } };
}

test('updates team surfaces runtime errors returned in a successful status response', async ({ page }) => {
  const state = await fixture(page, 'autopilot');
  state.comms.error = 'Could not read project evidence';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const team = page.getByRole('region', { name: 'Updates team' });
  await expect(team.getByRole('alert')).toContainText('Could not read project evidence');
  state.comms.error = null;
  await team.getByRole('button', { name: 'Try again' }).click();
  await expect(team.getByRole('alert')).toHaveCount(0);
});

test('slow updates team responses do not overlap or get discarded by polling', async ({ page }) => {
  await page.clock.install();
  let release;
  const waitForComms = new Promise(resolve => { release = resolve; });
  const state = await fixture(page, 'autopilot', { waitForComms });
  const team = page.getByRole('region', { name: 'Updates team' });
  await expect(team.getByRole('status')).toHaveText('Loading updates team…');
  await page.clock.fastForward(31000);
  expect(state.commsRequests()).toBe(1);
  release();
  await expect(team.getByRole('button', { name: 'Pause updates team' })).toBeVisible();
  await page.clock.fastForward(15000);
  await expect.poll(state.commsRequests).toBe(2);
});

for (const width of [1280, 390]) {
  test(`project update comments return replies at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const state = await fixture(page);
    const card = page.getByTestId('feed-item-project-update:morning');
    await card.getByRole('button', { name: 'Comment', exact: true }).click();
    await card.getByRole('textbox', { name: 'Comment on Your opponents play smarter' }).fill('Make opponents more aggressive.');
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(card).toContainText('Replyguy will respond here.');
    expect(state.comments).toEqual([{ evidenceId: 'project-update:morning', text: 'Make opponents more aggressive.' }]);
    state.item.comments[0].reply = { text: 'The team shipped more aggressive opponents. Give them a try.', timestamp: new Date().toISOString() };
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(card).toContainText('The team shipped more aggressive opponents.');
    await expect(card.getByTestId('feed-comment-comment-one')).toHaveCount(1);
    expect(state.steers).toEqual([]);
    expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`project-comments-${width}.png`), fullPage: true });
  });
}

test('failed comment keeps its draft and can be retried', async ({ page }) => {
  const state = await fixture(page); state.failComment();
  const card = page.getByTestId('feed-item-project-update:morning');
  await card.getByRole('button', { name: 'Comment', exact: true }).click();
  const input = card.getByRole('textbox'); await input.fill('Keep this request');
  await card.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveText('Temporarily unavailable');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(input).toHaveValue('Keep this request');
  await expect(card.getByRole('alert')).toHaveText('Temporarily unavailable');
  await card.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(card).toContainText('Replyguy will respond here.');
  expect(state.comments).toHaveLength(1);
});

test('blocked delegated work asks for input instead of claiming it is working', async ({ page }) => {
  const state = await fixture(page);
  state.item.comments.push({ id: 'blocked-comment', evidenceId: state.item.evidenceId, room: 'Example Game', text: 'Make this more aggressive.', createdAt: new Date().toISOString(), status: 'awaiting-task', taskId: 'blocked-task', taskStatus: 'blocked', reply: { text: 'Your team needs a choice about difficulty.', timestamp: new Date().toISOString() } });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const comment = page.getByTestId('feed-comment-blocked-comment');
  await expect(comment).toContainText('Your team needs input.');
  await expect(comment).not.toContainText('Your team is working on this.');
});

test('reply failure remains visible even after an initial acknowledgment', async ({ page }) => {
  const state = await fixture(page);
  state.item.comments.push({ id: 'failed-reply', evidenceId: state.item.evidenceId, room: 'Example Game', text: 'Improve instructions.', createdAt: new Date().toISOString(), status: 'awaiting-task', taskId: 'pending-task', error: 'Creator is unavailable', reply: { text: 'I will ask the team.', timestamp: new Date().toISOString() } });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const comment = page.getByTestId('feed-comment-failed-reply');
  await expect(comment).toContainText('Reply needs attention: Creator is unavailable');
  await expect(comment).not.toContainText('Your team is working on this.');
});

test('updates team has independent pause, resume and retry controls on mobile', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page, 'autopilot');
  const team = page.getByRole('region', { name: 'Updates team' });
  await expect(team).toContainText('Caretaker');
  await expect(team).toContainText('Session disconnected');
  await expect(team.getByRole('button', { name: 'Open chat' })).toHaveCount(2);
  state.failAction();
  await team.getByRole('button', { name: 'Pause updates team' }).click();
  await expect(team.getByRole('alert')).toContainText('Could not save');
  await team.getByRole('button', { name: 'Pause updates team' }).click();
  await expect(team.getByRole('button', { name: 'Resume updates team' })).toBeVisible();
  await expect(team).toContainText('not your chats');
  await team.getByRole('button', { name: 'Resume updates team' }).click();
  await team.getByRole('button', { name: 'Retry marketer for Example Game' }).click();
  await expect(team).toContainText('queued');
  expect(state.actions).toEqual([{ action: 'pause' }, { action: 'resume' }, { action: 'retry', jobId: 'failed-job' }]);
  expect(await team.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await team.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('updates-team-mobile.png'), fullPage: true });
});
