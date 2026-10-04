import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, defineTool, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { capMiddle, codemodeEnabled, createCodemodeExtension, createCodemodeTool } from '../src/codemode.js';
import { createFeatherTools, createWebFetchTool, featherBridge, htmlText } from '../src/tools.js';
import { modelCompleter, openMemory } from '../src/optchat/memory.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-codemode-'));
const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');

const echo = defineTool({
  name: 'echo',
  description: 'Echo a word',
  parameters: Type.Object({ word: Type.String() }),
  async execute({ word }) { return { content: [{ type: 'text', text: `echo:${word}` }] }; },
});
const streams = defineTool({
  name: 'streams',
  description: 'Writes through output()',
  parameters: Type.Object({}),
  async execute(_args, api) { api.output('line 1\n'); api.output('line 2'); api.diagnostic({ severity: 'warn', message: 'cut' }); return {}; },
});
const broken = defineTool({
  name: 'broken',
  description: 'Always fails',
  parameters: Type.Object({}),
  async execute() { return { content: [{ type: 'text', text: 'it broke' }], isError: true }; },
});

test('code mode is on unless switched off', () => {
  assert.equal(codemodeEnabled({}), true);
  for (const value of ['off', '0', 'false', 'no', 'plain', 'OFF']) assert.equal(codemodeEnabled({ FEATHER_PI_CODEMODE: value }), false);
  assert.equal(codemodeEnabled({ FEATHER_PI_CODEMODE: 'on' }), true);
});

test('codemode runs a script against the tools and returns only its output', async () => {
  const tool = createCodemodeTool([echo, streams, broken]);
  assert.match(tool.description, /echo\(args: \{\s*word: string;\s*\}\): Promise<string>/);
  const api = { output() {}, diagnostic() {}, async details() {} };
  const result = await tool.execute({ code: `
    const a = await tools.echo({ word: 'hi' });
    text(a);
    text(await tools.streams({}));
    try { await tools.broken({}); } catch (e) { text('caught ' + e.message); }
    try { await tools.echo({ word: 5 }); } catch (e) { text('bad ' + e.message); }
    return { n: 2 };
  ` }, api, ctx);
  assert.equal(result.isError, false);
  const out = text(result);
  assert.match(out, /^echo:hi\nline 1\nline 2\n\[warn: cut\]\ncaught broken: it broke\nbad echo: invalid arguments: \/word must be string\nreturn: \{"n":2\}$/);
  assert.deepEqual(result.details.calls.map(call => `${call.name}:${call.status}`), ['echo:ok', 'streams:ok', 'broken:error', 'echo:error']);

  const failed = await tool.execute({ code: 'text("before"); throw new Error("nope")' }, api, ctx);
  assert.equal(failed.isError, true);
  assert.match(text(failed), /^before\nscript error: Error: nope/);

  const silent = await tool.execute({ code: '1 + 1;' }, api, ctx);
  assert.equal(text(silent), '(no output)');
});

test('codemode stops a script at the deadline', async () => {
  const tool = createCodemodeTool([echo], { timeoutMs: 200 });
  const result = await tool.execute({ code: 'while (true) {}' }, { output() {}, diagnostic() {}, async details() {} }, ctx);
  assert.equal(result.isError, true);
  assert.match(text(result), /^timeout error/);
});

test('capMiddle keeps the head and tail', () => {
  const long = 'a'.repeat(500) + 'b'.repeat(500);
  const cut = capMiddle(long, 200);
  assert.ok(cut.length <= 200);
  assert.match(cut, /^a+\n\[… \d+ characters cut …\]\nb+$/);
});

test('htmlText drops scripts and tags and decodes entities', () => {
  assert.equal(htmlText('<html><head><title>x</title></head><body><script>bad()</script><h1>Hi &amp; bye</h1><p>One<br>two&#33;</p><ul><li>a</li></ul></body></html>'), 'Hi & bye\nOne\ntwo!\n\n- a');
});

test('web_fetch returns text, turns HTML into text, refuses other schemes', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/page') { res.setHeader('content-type', 'text/html'); res.end('<p>Hello <b>web</b></p>'); return; }
    if (req.url === '/bin') { res.setHeader('content-type', 'image/png'); res.end(Buffer.alloc(10)); return; }
    res.statusCode = 404; res.setHeader('content-type', 'text/plain'); res.end('missing');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tool = createWebFetchTool();
  try {
    const page = await tool.execute({ url: `${base}/page` }, {}, ctx);
    assert.match(text(page), /^HTTP 200 .*\ncontent-type: text\/html\n\nHello web$/);
    assert.match(text(await tool.execute({ url: `${base}/bin` }, {}, ctx)), /binary content, 10 bytes/);
    const missing = await tool.execute({ url: `${base}/nope` }, {}, ctx);
    assert.equal(missing.isError, true);
    assert.equal((await tool.execute({ url: 'file:///etc/passwd' }, {}, ctx)).isError, true);
  } finally {
    server.close();
  }
});

test('Feather tools post to the chat, with the token only in the header', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    if (String(url).endsWith('/links') && init.headers['X-Feather-Bridge-Token'] !== 'secret-token') return new Response('{"error":"Invalid session capability"}', { status: 403 });
    return new Response(JSON.stringify({ ok: true, links: [] }), { status: 200 });
  };
  const bridge = featherBridge({ FEATHER_URL: 'http://127.0.0.1:3300/', FEATHER_SESSION_ID: 'abc', FEATHER_BRIDGE_TOKEN: 'secret-token' });
  assert.deepEqual(bridge, { baseUrl: 'http://127.0.0.1:3300', sessionId: 'abc', token: 'secret-token' });
  const [rename, link] = createFeatherTools(bridge, { fetchImpl });
  assert.equal(text(await rename.execute({ title: '  Plan\nthe   trip ' }, {}, ctx)), 'Chat renamed to "Plan the trip".');
  assert.deepEqual(seen[0], { url: 'http://127.0.0.1:3300/api/sessions/abc/rename', headers: { 'Content-Type': 'application/json' }, body: { title: 'Plan the trip' } });
  const added = await link.execute({ action: 'add', label: 'Report', target: '/tmp/r.md', front: true }, {}, ctx);
  assert.equal(added.isError, undefined);
  assert.deepEqual(seen[1].body, { action: 'add', label: 'Report', target: '/tmp/r.md', front: true });
  assert.equal(seen[1].url, 'http://127.0.0.1:3300/api/internal/sessions/abc/links');

  const [, badLink] = createFeatherTools({ ...bridge, token: 'wrong' }, { fetchImpl });
  const denied = await badLink.execute({ action: 'read' }, {}, ctx);
  assert.equal(denied.isError, true);
  assert.doesNotMatch(text(denied), /wrong|secret/);
  const [offRename] = createFeatherTools(featherBridge({}), { fetchImpl });
  assert.equal((await offRename.execute({ title: 'x' }, {}, ctx)).isError, true);
});

test('a pi run in code mode writes and reads files in the chat folder and zooms its memory', async () => {
  const cwd = tmp();
  const sessionDir = tmp();
  const chat = fauxProvider({ provider: 'chat', api: 'faux-chat', models: [{ id: 'm' }] });
  const cheap = fauxProvider({ provider: 'cheap', api: 'faux-cheap', models: [{ id: 's' }] });
  const models = createModels();
  models.setProvider(chat.provider);
  models.setProvider(cheap.provider);
  cheap.setResponses(Array.from({ length: 50 }, () => () => fauxAssistantMessage('S')));
  const memory = openMemory({ sessionDir, complete: modelCompleter(models, { provider: 'cheap', modelId: 's' }), modelName: 'cheap/s', settleMs: 5000, offerTools: false });
  memory.addNote('the code word is PELICAN');

  const requests = [];
  const script = `
    await tools.write({ path: 'notes.txt', content: 'alpha\\nbeta\\n' });
    const body = await tools.read({ path: 'notes.txt' });
    const shell = await tools.bash({ command: 'wc -l < notes.txt && pwd' });
    const word = await tools.zoom({ id: 0, n: 1 });
    text(body.includes('beta') ? 'read ok' : 'read bad');
    text(shell.trim());
    text(word);
  `;
  chat.setResponses([
    context => { requests.push(context); return fauxAssistantMessage(fauxToolCall('codemode', { code: script }), { stopReason: 'toolUse' }); },
    context => { requests.push(context); return fauxAssistantMessage(fauxText('done')); },
  ]);
  const registry = createRegistry();
  registry.install(memory.extension);
  registry.install(createCodemodeExtension([...CodingTools.tools, ...memory.tools]));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir || cwd }) }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: 'chat', modelId: 'm' }, cwd } });
  await memory.attach(root, ctx);
  const submission = await root.submit({ type: 'input', content: 'Do it', whenBusy: 'steer' }, ctx);
  assert.equal((await submission.wait(ctx)).status, 'done');

  // Only codemode is offered; the others live inside it.
  const offered = requests[0].messages[0].toolsAdded;
  assert.deepEqual(offered.map(tool => tool.name), ['codemode']);
  assert.match(offered[0].description, /zoom\(args/);
  const result = requests[1].messages.find(message => message.role === 'toolResult');
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.equal(result.content[0].text, `read ok\n2\n${fs.realpathSync(cwd)}\n0+0|note: the code word is PELICAN`);
  assert.equal(fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8'), 'alpha\nbeta\n');
  memory.stop();
  await harness.close(ctx);
});
