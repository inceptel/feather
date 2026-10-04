import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { COMPACT, MASTER, SCALE, VIEW_DOC } from '../src/optchat/prompts.js';
import { bytes, openStore } from '../src/optchat/store.js';
import { createView, NODE, PLACEHOLDER } from '../src/optchat/view.js';
import { createCompactor, cutBytes } from '../src/optchat/compactor.js';
import { markViewPayload, splitView } from '../src/optchat/cache.js';
import { capText, entryMessages, logEntries, runStart } from '../src/optchat/extension.js';
import { memoryEnabled, modelCompleter, openMemory } from '../src/optchat/memory.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-optchat-'));
const long = (tag, n = 700) => `${tag} ${'x'.repeat(n)}`;
const reply = text => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });
const lastUserText = messages => {
  const user = messages[messages.length - 1];
  return typeof user.content === 'string' ? user.content : user.content.map(block => block.text).join('\n');
};
/** A fake compactor: "S(<first 20 chars of the source>)". */
const fakeComplete = async messages => {
  const step = lastUserText(messages).split('\n').slice(-2).join(' ');
  return reply(`S(${step.slice(0, 20)})`);
};
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test('prompts: the scale line is exactly one node', () => {
  assert.equal(bytes(SCALE), NODE);
  assert.match(COMPACT, /\S/);
  assert.doesNotMatch(`${MASTER}${VIEW_DOC}`, /OptChat/);
});

test('store: appends, reloads, skips torn lines, keeps ids dense', () => {
  const dir = tmp();
  const store = openStore(dir);
  store.addMessage('user', 'hello', { src: 3, part: 0 });
  store.addMessage('talk', 'hi', { src: 4, part: 0 });
  store.addNode(0, 0, 'user: hello');
  assert.deepEqual(store.lastSrc(), { src: 4, part: 0 });
  const day = fs.readdirSync(path.join(dir, 'main'))[0];
  fs.appendFileSync(path.join(dir, 'main', day), '{"i":2,"kind":"note","te');
  const reports = [];
  const again = openStore(dir, { report: text => reports.push(text) });
  assert.equal(again.messages.length, 2);
  assert.equal(again.node(0, 0).text, 'user: hello');
  assert.ok(reports.some(text => /torn/.test(text)));
  again.addMessage('note', 'after the tear');
  assert.equal(openStore(dir).messages.length, 3);
  assert.equal((fs.statSync(path.join(dir, 'main', day)).mode & 0o777), 0o600);
});

test('view: tiles the chat, merges the most due built pair, renders ids', () => {
  const store = openStore(tmp());
  for (let i = 0; i < 8; i++) store.addMessage('note', long(`m${i}`, 200));
  const view = createView(store, { budget: 4 * 220 });
  view.fold();
  assert.equal(view.parts.length, 8); // no parents built yet: never merge into a hole
  for (let i = 0; i < 8; i++) store.addNode(0, i, `n${i} ${'y'.repeat(200)}`);
  for (let i = 0; i < 4; i++) store.addNode(1, i, `p${i} ${'z'.repeat(200)}`);
  view.fit();
  // The oldest pairs are most due and merge first.
  assert.deepEqual(view.parts.map(part => `${part.l}:${part.i}`), ['1:0', '1:1', '1:2', '1:3']);
  assert.ok(view.size() <= 4 * 220);
  assert.match(view.render(), /^<chat>\n0\+2\|p0 /);
  assert.match(view.render(3), /^<chat>\n0\+2\|p0 z+\n2\+2\|p1 z+\n<\/chat>$/);
  assert.equal(view.first(), 8);
});

test('view: settle waits for summaries before k, and times out', async () => {
  const store = openStore(tmp());
  for (let i = 0; i < 3; i++) store.addMessage('note', long(`m${i}`));
  const view = createView(store);
  view.fold();
  assert.match(view.render(), new RegExp(PLACEHOLDER.replace(/[()]/g, '\\$&')));
  assert.equal(await view.settle(2, { timeoutMs: 20 }), false);
  const settled = view.settle(2);
  store.addNode(0, 0, 'a');
  view.fit();
  store.addNode(0, 1, 'b');
  view.fit();
  assert.equal(await settled, true);
  assert.equal(view.settledBefore(3), false);
});

test('compactor: builds in order, free nodes skip the model, retries with the cut', async () => {
  const store = openStore(tmp());
  const view = createView(store, { budget: 10_000 });
  const calls = [];
  const complete = async messages => {
    calls.push(messages);
    const text = lastUserText(messages);
    if (/^That line is/.test(text)) return reply('short enough');
    return reply(calls.length === 1 ? 'w'.repeat(NODE + 10) : `S${calls.length}`);
  };
  const compactor = createCompactor({ store, view, complete, model: 'fake/model' });
  store.addMessage('note', long('first'));
  store.addMessage('user', 'tiny');
  view.fold();
  compactor.pump();
  await until(() => view.built(1, 0));
  // Message 0: too long, then cut at the limit and retried.
  assert.equal(store.node(0, 0).text, 'short enough');
  assert.equal(store.node(0, 0).model, 'fake/model');
  assert.match(lastUserText(calls[1]), /\| ← LIMIT$/);
  // Message 1 and the merge fit in a node: no model call.
  assert.equal(store.node(0, 1).text, 'user: tiny');
  assert.equal(store.node(1, 0).text, 'short enough\nuser: tiny');
  assert.equal(calls.length, 2);
  // Message 0's context is the view before it: empty.
  assert.equal(calls[0][1].content[0].text, '<chat>\n</chat>');
  compactor.stop();
});

test('compactor: a failure is reported once and retried', async () => {
  const store = openStore(tmp());
  const view = createView(store);
  let fail = 2;
  const reports = [];
  const complete = async () => {
    if (fail-- > 0) return { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom' };
    return reply('ok');
  };
  const compactor = createCompactor({ store, view, complete, retryMs: 10, report: text => reports.push(text) });
  store.addMessage('note', long('a'));
  view.fold();
  compactor.pump();
  await until(() => view.built(0, 0));
  assert.equal(reports.length, 1);
  assert.match(reports[0], /boom/);
  compactor.stop();
});

test('cutBytes never splits a character', () => {
  assert.equal(cutBytes('aé', 2), 'a');
  assert.equal(cutBytes('abc', 2), 'ab');
});

test('cache: marks the view at line ends before 50k, 80k, 100k', () => {
  const lines = Array.from({ length: 300 }, (_, k) => `${k}+1|${'v'.repeat(400)}`);
  const view = `<chat>\n${lines.join('\n')}\n</chat>`;
  const pieces = splitView(view);
  assert.equal(pieces.join(''), view);
  assert.equal(pieces.length, 4);
  for (const piece of pieces.slice(0, 3)) assert.ok(piece.endsWith('\n'));
  assert.ok(pieces[0].length <= 50_000);
  const payload = {
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 't', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: view }, { type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] }],
  };
  markViewPayload(payload);
  const content = payload.messages[0].content;
  assert.equal(content.length, 5);
  assert.deepEqual(content.map(block => !!block.cache_control), [true, true, true, false, true]);
  let marks = content.filter(block => block.cache_control).length;
  marks += payload.system.filter(block => block.cache_control).length + payload.tools.filter(tool => tool.cache_control).length;
  assert.equal(marks, 4);
  // A short view is left alone.
  const small = { messages: [{ role: 'user', content: [{ type: 'text', text: '<chat>\n0+1|a\n</chat>' }] }] };
  markViewPayload(small);
  assert.equal(small.messages[0].content.length, 1);
});

test('entries map to OptChat messages; logging is idempotent', () => {
  const user = { id: 5, kind: 'pi.user', model: [{ role: 'user', content: 'do it', timestamp: 1 }] };
  const assistant = { id: 6, kind: 'pi.assistant', model: [{ role: 'assistant', stopReason: 'toolUse', timestamp: 2, content: [{ type: 'thinking', thinking: 'secret plan' }, { type: 'text', text: 'ok' }, { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }] }] };
  const result = { id: 7, kind: 'pi.tool-result', model: [{ role: 'toolResult', content: [{ type: 'text', text: 'a\nb' }], timestamp: 3 }] };
  assert.deepEqual(entryMessages(assistant), [{ kind: 'talk', text: 'ok' }, { kind: 'tool', text: 'bash {"command":"ls"}' }]);
  const store = openStore(tmp());
  assert.equal(logEntries(store, [result, user, assistant]).length, 4);
  assert.equal(logEntries(store, [user, assistant, result]).length, 0);
  assert.deepEqual(store.messages.map(row => row.kind), ['user', 'talk', 'tool', 'echo']);
  assert.ok(!store.messages.some(row => /secret plan/.test(row.text)));
  const capped = capText('z'.repeat(50_000));
  assert.ok(capped.length <= 30_000 && /characters cut/.test(capped));
});

test('runStart finds the first user message after the last final answer', () => {
  const user = text => ({ role: 'user', content: text });
  const call = { role: 'assistant', content: [{ type: 'toolCall', name: 'x', arguments: {} }] };
  assert.equal(runStart([user('a'), reply('b'), user('c'), call, { role: 'toolResult', content: [] }]), 2);
  assert.equal(runStart([user('a')]), 0);
  assert.equal(runStart([user('a'), reply('b')]), -1);
});

test('memory switch defaults on', () => {
  assert.equal(memoryEnabled({}), true);
  assert.equal(memoryEnabled({ FEATHER_PI_MEMORY: 'off' }), false);
  assert.equal(memoryEnabled({ FEATHER_PI_MEMORY: '0' }), false);
});

test('a pi run sees the frozen view, can zoom, and is logged after', async () => {
  const sessionDir = tmp();
  const chat = fauxProvider({ provider: 'chat', api: 'faux-chat', models: [{ id: 'm' }] });
  const summarizer = fauxProvider({ provider: 'cheap', api: 'faux-cheap', models: [{ id: 's' }] });
  const models = createModels();
  models.setProvider(chat.provider);
  models.setProvider(summarizer.provider);
  summarizer.setResponses(Array.from({ length: 200 }, () => context => fauxAssistantMessage(`S:${lastUserText(context.messages).split('\n').pop().slice(0, 12)}`)));

  const memory = openMemory({ sessionDir, complete: modelCompleter(models, { provider: 'cheap', modelId: 's' }), modelName: 'cheap/s', budget: 3000, settleMs: 5000 });
  for (let i = 0; i < 20; i++) memory.addNote(long(i === 5 ? 'the code word is PELICAN' : `note ${i}`));

  const requests = [];
  chat.setResponses([
    context => { requests.push(context.messages); return fauxAssistantMessage(fauxToolCall('zoom', { id: 5, n: 1 }), { stopReason: 'toolUse' }); },
    context => { requests.push(context.messages); return fauxAssistantMessage(fauxText('PELICAN')); },
  ]);
  const registry = createRegistry();
  registry.install(memory.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: 'chat', modelId: 'm' } } });
  await memory.attach(root, ctx);
  const submission = await root.submit({ type: 'input', content: 'What is the code word?', whenBusy: 'steer' }, ctx);
  assert.equal((await submission.wait(ctx)).status, 'done');

  assert.equal(requests.length, 2);
  const [first, second] = requests;
  const viewOf = messages => messages.find(message => message.role === 'user').content[0].text;
  assert.match(viewOf(first), /^<chat>\n0\+\d+\|S:/);
  assert.equal(viewOf(second), viewOf(first)); // frozen for the run: same bytes, same cache
  assert.ok(Buffer.byteLength(viewOf(first)) <= 3000 + 100);
  assert.doesNotMatch(viewOf(first), /not summarized yet/);
  const echo = second.find(message => message.role === 'toolResult');
  assert.match(echo.content[0].text, /^5\+0\|note: the code word is PELICAN/);
  assert.equal(first[0].role, 'system');
  assert.match(first[0].sections?.optchat ?? JSON.stringify(first[0]), /zoom/);

  await memory.log();
  assert.deepEqual(memory.store.messages.slice(20).map(row => row.kind), ['user', 'tool', 'echo', 'talk']);
  const turns = fs.readFileSync(path.join(sessionDir, 'turns.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].k, 20);
  assert.equal(turns[0].settled, true);

  // After a reset, the next run carries the chat only through the view.
  await root.reset(undefined, ctx);
  chat.appendResponses([context => { requests.push(context.messages); return fauxAssistantMessage(fauxText('done')); }]);
  const next = await root.submit({ type: 'input', content: 'And again?', whenBusy: 'steer' }, ctx);
  assert.equal((await next.wait(ctx)).status, 'done');
  const third = requests[2];
  assert.deepEqual(third.map(message => message.role), ['system', 'user']);
  assert.ok(viewOf(third).endsWith('\n</chat>'));
  assert.equal(third[1].content.at(-1).text, 'And again?');
  await memory.log();
  assert.equal(memory.store.messages.length, 26);

  // A restart re-derives nothing twice and re-folds the same view.
  memory.stop();
  const again = openMemory({ sessionDir, complete: async () => reply('x'), budget: 3000 });
  assert.equal(again.store.messages.length, 26);
  await again.attach(root, ctx);
  assert.equal(again.store.messages.length, 26);
  again.stop();
  await harness.close(ctx);
});
