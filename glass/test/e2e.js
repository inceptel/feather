// End-to-end check against a mock Feather. Never touches real chats.
const http = require('http'), { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const MOCK = 4897, PORT = 4898, BASE = `http://127.0.0.1:${PORT}`;
const sent = [], answers = []; let aStatus = 'working', ask = false;
const mock = http.createServer((req, res) => {
  const j = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const u = req.url.split('?')[0]; let m0;
  if (u === '/api/running' && ask) return j({ items: [{ id: 'chat-cccc-3333', title: 'TPA paper revision', status: 'waiting', updatedAt: new Date().toISOString(), question: { type: 'selector', question: 'Submit the revision now?', options: ['❯ 1. Yes, submit', '2. Wait for Zerin', '3. Show me the diff first'], selectedIndex: 0 } }] });
  if ((m0 = /^\/api\/sessions\/([^/]+)\/answer$/.exec(u)) && req.method === 'POST') { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { answers.push({ id: m0[1], ...JSON.parse(b) }); ask = false; j({ ok: true }); }); return; }
  if (u === '/api/running') return j({ items: aStatus === 'working' ? [{ id: 'chat-aaaa-1111', title: 'Quiet Car sketch and Banana Show films', status: 'working', activity: '✻ Rendering take 4…', updatedAt: new Date().toISOString() }] : [] });
  if (u === '/api/sessions') return j({ sessions: [
    { id: 'chat-aaaa-1111', title: 'Quiet Car sketch and Banana Show films', updatedAt: new Date().toISOString(), outcome: 'finished' },
    { id: 'chat-bbbb-2222', title: 'Best electric toothbrush', updatedAt: new Date(Date.now() - 7200e3).toISOString(), outcome: 'finished' },
    { id: 'chat-cccc-3333', title: 'TPA paper revision', updatedAt: new Date(Date.now() - 9e7).toISOString(), outcome: 'errored' } ] });
  let m;
  if ((m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(u))) return j({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'Which one should I get at Costco?' }] },
    { role: 'user', content: [{ type: 'text', text: '<task-notification>noise</task-notification>' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] },
    { role: 'assistant', stopReason: 'end_turn', content: [{ type: 'text', text: `Answer for ${m[1]}: get the **Oral-B iO Series 5** two-pack.\n\n- Pressure sensor\n- Two handles\n\n` + 'It is the better value this week. '.repeat(30) + '<script>alert(1)</script>' }] } ] });
  if ((m = /^\/api\/sessions\/([^/]+)\/send$/.exec(u)) && req.method === 'POST') { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { sent.push({ id: m[1], ...JSON.parse(b), mid: req.headers['x-feather-message-id'] }); j({ ok: true }); }); return; }
  res.writeHead(404); res.end('{}');
}).listen(MOCK);
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-'));
const fakeClaude = path.join(state, 'claude'); // stands in for the model: echoes a fixed list
fs.writeFileSync(fakeClaude, '#!/bin/sh\ncat >/dev/null\necho \'Sure: ["Get the Series 5", "Get the Series 6 instead", "Skip it for now", "What is the price gap?"]\'\n', { mode: 0o755 });
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, GLASS_PORT: PORT, GLASS_FEATHER: `http://127.0.0.1:${MOCK}`, GLASS_STATE: state, GLASS_CLAUDE: fakeClaude, GLASS_ORIGIN: BASE, GLASS_OWNER: 'owner' }, stdio: 'inherit' });
const shots = process.argv[2] || state;
(async () => {
  await new Promise((r) => setTimeout(r, 600));
  // --- gateway refuses the unauthenticated
  assert.equal((await fetch(BASE + '/glass/api/chats')).status, 401, 'no token');
  assert.equal((await fetch(BASE + '/glass/api/chats', { headers: { Authorization: 'Bearer ' + 'a'.repeat(64) } })).status, 401, 'bad token');
  assert.equal((await fetch(BASE + '/glass-approve')).status, 403, 'approve needs Remote-User');
  assert.equal((await fetch(BASE + '/glass-approve', { headers: { 'Remote-User': 'tobin' } })).status, 403, 'approve needs owner');
  assert.equal((await fetch(BASE + '/api/sessions')).status, 404, 'no open proxy');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(BASE + '/glass/');
  await page.waitForFunction(() => /\d{3} \d{3}/.test(document.getElementById('code').textContent));
  const code = (await page.textContent('#code')).replace(/\s/g, '');
  await page.screenshot({ path: path.join(shots, '1-pair.png') });

  const form = await (await fetch(BASE + '/glass-approve', { headers: { 'Remote-User': 'owner' } })).text();
  const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(form)[1];
  const post = (body, headers) => fetch(BASE + '/glass-approve', { method: 'POST', headers: { 'Remote-User': 'owner', 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body });
  assert.equal((await post(`csrf=${csrf}&action=approve&code=${code}`, { Origin: 'https://evil.example' })).status, 403, 'cross-site approve blocked');
  assert.equal((await post(`csrf=nope&action=approve&code=${code}`, { Origin: BASE })).status, 403, 'bad csrf blocked');
  assert.match(await (await post(`csrf=${csrf}&action=approve&code=000000`, { Origin: BASE })).text(), /not showing/, 'wrong code');
  assert.match(await (await post(`csrf=${csrf}&action=approve&code=${code}`, { Origin: BASE })).text(), /Paired\./, 'approve');
  assert.match(await (await post(`csrf=${csrf}&action=approve&code=${code}`, { Origin: BASE })).text(), /not showing/, 'code is single use');

  await page.waitForSelector('#title:has-text("Quiet Car")', { timeout: 8000 });
  await page.waitForSelector('#last');
  assert.equal(await page.textContent('#status'), 'Working');
  assert.equal(await page.locator('#panel script').count(), 0, 'message html is escaped');
  assert.ok(!(await page.textContent('#panel')).includes('task-notification'), 'noise filtered');
  await page.screenshot({ path: path.join(shots, '2-working.png') });

  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('#title:has-text("toothbrush")');
  await page.waitForSelector('#last:has-text("chat-bbbb-2222")');
  await page.screenshot({ path: path.join(shots, '3-finished.png') });
  // Select from the message jumps to the bottom and onto Suggest; right moves to the reply field.
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'suggest');
  assert.ok(await page.evaluate(() => { const p = document.getElementById('panel'); return p.scrollTop + p.clientHeight >= p.scrollHeight - 4; }), 'jumped to the end');
  await page.keyboard.press('ArrowRight'); assert.equal(await page.evaluate(() => document.activeElement.id), 'draft');
  await page.keyboard.press('ArrowLeft'); assert.equal(await page.evaluate(() => document.activeElement.id), 'suggest');
  await page.keyboard.press('ArrowUp'); await page.evaluate(() => { document.getElementById('panel').scrollTop = 0; });
  let swipes = 0; while (await page.evaluate(() => document.activeElement.id) === 'panel' && swipes < 20) { await page.keyboard.press('ArrowDown'); swipes++; }
  assert.ok(swipes <= 4, 'long message takes few swipes, took ' + swipes);
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'draft', 'down past the end reaches the reply field');
  // Suggested replies: press the button, pick one, confirm with Send.
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'suggest');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#choices.suggest button:focus');
  assert.equal(await page.locator('#choices button').count(), 4);
  await page.screenshot({ path: path.join(shots, '4a-suggest.png') });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#draft'), 'Get the Series 6 instead');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'send', 'picked guess waits on Send');
  assert.equal(sent.length, 0, 'picking a guess does not send by itself');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter'); // Clear
  await page.keyboard.press('Enter'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 8 && await page.evaluate(() => document.activeElement.id) !== 'draft'; i++) await page.keyboard.press('ArrowDown');
  // The glasses composer sets the value and fires input/change with no key events.
  await page.evaluate(() => { const d = document.getElementById('draft'); d.value = 'Get the Series 5 then'; d.dispatchEvent(new Event('input', { bubbles: true })); d.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'send', 'focus lands on Send after composing');
  await page.screenshot({ path: path.join(shots, '4-draft.png') });
  await page.keyboard.press('ArrowRight'); assert.equal(await page.evaluate(() => document.activeElement.id), 'clear');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('draft').value === '');
  assert.deepEqual([sent.length, sent[0].id, sent[0].text], [1, 'chat-bbbb-2222', 'Get the Series 5 then']);
  assert.match(sent[0].mid, /^glass-/);

  // Another chat finishes while this one is on screen.
  aStatus = 'done';
  await page.waitForSelector('#notice.on:has-text("Finished: Quiet Car")', { timeout: 15000 });
  await page.screenshot({ path: path.join(shots, '5-notice.png') });
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
  await page.waitForSelector('#title:has-text("Quiet Car")');

  // A chat asks a multiple-choice question: options appear, one press answers.
  ask = true;
  await page.waitForSelector('#notice.on:has-text("Needs you: TPA")', { timeout: 15000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('#choices.answer button');
  for (let i = 0; i < 14 && !(await page.evaluate(() => !!document.activeElement.closest('#choices'))); i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(280); }
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Yes, submit', 'option text is cleaned of menu markers');
  await page.screenshot({ path: path.join(shots, '6-question.png') });
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Wait for Zerin');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#notice.on:has-text("Answered")');
  assert.deepEqual(answers, [{ id: 'chat-cccc-3333', type: 'selector', index: 1 }]);

  // Reload keeps the pairing; unpairing sends the device back to the code screen.
  await page.reload(); await page.waitForSelector('#title:has-text("TPA paper")'); // reopens on the chat last viewed
  await post(`csrf=${csrf}&action=revoke`, { Origin: BASE });
  await page.waitForSelector('#pair:not([hidden])', { timeout: 15000 });
  assert.equal(fs.statSync(path.join(state, 'tokens.json')).mode & 0o777, 0o600);
  assert.deepEqual(errors.filter((e) => !/401/.test(e)), [], 'no page errors');
  await browser.close(); console.log('PASS, screenshots in', shots);
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; }).finally(() => { srv.kill(); mock.close(); setTimeout(() => process.exit(), 300); });
