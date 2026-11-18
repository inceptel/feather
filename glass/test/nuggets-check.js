// Nuggets end to end on a private port: a fake microphone plays a recorded sentence into the glasses page.
// Uses the real transcription and model services (a few cents). Usage: node nuggets-check.js <shots> <wav>
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const PORT = 4898, L = `http://127.0.0.1:${PORT}`;
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'glassn-'));
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, GLASS_PORT: PORT, GLASS_STATE: state, GLASS_ORIGIN: L, GLASS_OWNER: 'owner' }, stdio: 'inherit' });
const [shots, wav] = process.argv.slice(2);
(async () => {
  await new Promise((r) => setTimeout(r, 700));
  assert.equal((await fetch(L + '/glass/api/nuggets')).status, 401, 'nuggets need a paired device');
  assert.equal((await fetch(L + '/glass/api/nuggets/audio', { method: 'POST', body: 'x' })).status, 401, 'audio needs a paired device');
  assert.equal((await fetch(L + '/glass-mic')).status, 403, 'phone mic page needs the sign-in');
  assert.equal((await fetch(L + '/glass-mic/audio', { method: 'POST', headers: { 'Remote-User': 'owner', Origin: 'https://evil.example' }, body: 'x' })).status, 403, 'cross-site audio refused');
  const H = { 'Remote-User': 'owner', Origin: L, 'Content-Type': 'application/x-www-form-urlencoded' };
  const { id, code } = await (await fetch(L + '/glass/api/pair/start', { method: 'POST' })).json();
  const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(await (await fetch(L + '/glass-approve', { headers: H })).text())[1];
  await fetch(L + '/glass-approve', { method: 'POST', headers: H, body: `csrf=${csrf}&action=approve&code=${code}` });
  const { token } = await (await fetch(L + '/glass/api/pair/poll?id=' + id)).json();
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav] });
  const ctx = await b.newContext({ viewport: { width: 600, height: 600 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('glass.token', t); } catch (e) {} }, token);
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(L + '/glass/nuggets');
  await page.waitForSelector('#mic:focus'); await page.screenshot({ path: path.join(shots, 'n1-idle.png') });
  const t0 = Date.now(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('state').textContent.startsWith('Listening') || document.getElementById('state').textContent === 'Thinking', null, { timeout: 30000 });
  console.log('first audio heard after', Date.now() - t0, 'ms:', await page.textContent('#heardt'));
  await page.screenshot({ path: path.join(shots, 'n2-listening.png') });
  await page.waitForFunction(() => document.getElementById('kind').textContent, null, { timeout: 60000 });
  console.log('first nugget after', Date.now() - t0, 'ms:', await page.textContent('#kind'), '|', await page.textContent('#text'));
  await page.screenshot({ path: path.join(shots, 'n3-nugget.png') });
  // phone page renders and reports the same state
  const ph = await b.newContext({ viewport: { width: 390, height: 780 }, extraHTTPHeaders: { 'Remote-User': 'owner' } }); const pp = await ph.newPage();
  await pp.goto(L + '/glass-mic'); await pp.waitForSelector('#list div', { timeout: 10000 }); await pp.screenshot({ path: path.join(shots, 'n4-phone.png') });
  assert.equal(fs.readdirSync(state).filter((f) => /\.(webm|wav|txt)$/.test(f)).length, 0, 'no audio or transcript on disk');
  assert.deepEqual(errs, []); await b.close(); console.log('PASS');
})().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(() => { srv.kill(); setTimeout(() => process.exit(), 300); });
