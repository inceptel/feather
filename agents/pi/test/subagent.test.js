import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, defineExtension, Harness, LiveDoc, MemoryStorage } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { createCodemodeExtension } from '../src/codemode.js';
import { modelCompleter, openMemory } from '../src/optchat/memory.js';
import { createSubagentExtension, createSubagentTaskExtension, createSubagentTools, firstMessage, Subagents, subagentsEnabled } from '../src/subagent.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-'));
const textOf = content => (typeof content === 'string' ? content : (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'));
const last = context => [...context.messages].reverse().find(m => m.role !== 'system');
// The newest text: after a view reset, the user message is [view, text].
const lastText = context => { const content = last(context).content; return typeof content === 'string' ? content : textOf([...content].reverse().filter(b => b.type === 'text').slice(0, 1)); };
const firstUser = context => textOf(context.messages.find(m => m.role === 'user')?.content);
const systemOf = context => JSON.stringify(context.messages.filter(m => m.role === 'system'));
// The system message follows the first user message, so find it by role.
const isChild = context => /You are a subagent of pi/.test(systemOf(context));
const toolsOf = context => context.messages.filter(m => m.role === 'system').flatMap(m => m.toolsAdded || []).map(t => t.name);
const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
const say = text => fauxAssistantMessage(fauxText(text));

/** Wait for every reporter of the chat, then for the chat to be idle. */
async function settle(harness, root) {
  for (;;) {
    const reporters = (await harness.snapshot(Subagents, root.id, ctx))?.reporters ?? [];
    for (const id of reporters) await harness.waitForTask(id, ctx);
    await root.waitForIdle(ctx);
    const again = (await harness.snapshot(Subagents, root.id, ctx))?.reporters ?? [];
    if (again.length === reporters.length) return;
  }
}

async function userTexts(root) {
  const page = await root.entries({}, 100, undefined, ctx);
  return page.items.filter(e => e.kind === 'pi.user').map(e => textOf(e.model[0].content)).reverse();
}

/** A chat with memory (one note: PELICAN) wired as main.js does; `respond(context)` plays the model. */
async function openChat({ codemode, respond }) {
  const cwd = tmp();
  const chat = fauxProvider({ provider: 'chat', api: 'faux-chat', models: [{ id: 'm' }] });
  const cheap = fauxProvider({ provider: 'cheap', api: 'faux-cheap', models: [{ id: 's' }] });
  const models = createModels();
  models.setProvider(chat.provider);
  models.setProvider(cheap.provider);
  cheap.setResponses(Array.from({ length: 80 }, () => () => fauxAssistantMessage('S')));
  const requests = [];
  chat.setResponses(Array.from({ length: 50 }, () => context => { requests.push(context); return respond(context); }));
  const memory = openMemory({ sessionDir: tmp(), complete: modelCompleter(models, { provider: 'cheap', modelId: 's' }), modelName: 'cheap/s', settleMs: 5000, offerTools: false });
  memory.addNote('the code word is PELICAN');
  const options = { remove: () => [memory.extension], view: () => memory.extension.frozenView() };
  const registry = createRegistry();
  registry.install(memory.extension);
  if (codemode) {
    registry.install(createCodemodeExtension([...CodingTools.tools, ...memory.tools, ...createSubagentTools(options)]));
    registry.install(createSubagentTaskExtension());
  } else {
    registry.install(CodingTools);
    registry.install(defineExtension({ name: 'optchat-tools', tools: memory.tools }));
    registry.install(createSubagentExtension(options));
  }
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir || cwd }) }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: 'chat', modelId: 'm' }, cwd, instructions: 'The user likes short answers.' } });
  await memory.attach(root, ctx);
  return {
    requests,
    root,
    async ask(content) {
      await (await root.submit({ type: 'input', content, whenBusy: 'steer' }, ctx)).wait(ctx);
      await settle(harness, root);
    },
    async close() { memory.stop(); await harness.close(ctx); },
  };
}

test('subagents are on unless switched off', () => {
  assert.equal(subagentsEnabled({}), true);
  assert.equal(subagentsEnabled({ FEATHER_PI_SUBAGENTS: 'off' }), false);
  assert.equal(firstMessage('', 'do x'), 'do x');
  assert.equal(firstMessage('<chat>\n</chat>', 'do x'), '<chat>\n</chat>\n\nYour task:\ndo x');
});

test('plain mode: spawn runs subagents in the background and reports them as one message', async () => {
  const chat = await openChat({
    codemode: false,
    respond(context) {
      const message = last(context);
      if (isChild(context)) return say(`done ${firstUser(context).split('Your task:\n')[1]}`);
      if (message.role === 'toolResult') return say('They are running.');
      if (lastText(context).startsWith('[s1]')) return say('Both finished.');
      return call('spawn', { tasks: ['task A', 'task B'] });
    },
  });
  await chat.ask('Split the work');
  const children = chat.requests.filter(isChild);
  assert.equal(children.length, 2);
  for (const child of children) {
    // Spec §9: the view at spawn time, then the task; SUBAGENT, VIEW_DOC and the user's instructions.
    assert.match(firstUser(child), /^<chat>[\s\S]*PELICAN[\s\S]*<\/chat>\n\nYour task:\ntask [AB]$/);
    assert.match(systemOf(child), /You are a subagent of pi[\s\S]*The user likes short answers/);
    const tools = toolsOf(child);
    for (const name of ['zoom', 'date', 'bash']) assert.ok(tools.includes(name), tools.join(','));
    for (const name of ['spawn', 'tell']) assert.ok(!tools.includes(name), tools.join(','));
  }
  const parent = chat.requests.filter(r => !isChild(r));
  assert.ok(toolsOf(parent[0]).includes('spawn'));
  assert.match(textOf(parent[1].messages.find(m => m.role === 'toolResult').content), /^Started \[s1\] \[s2\]\./);
  // The reports arrive as one user message.
  const users = await userTexts(chat.root);
  assert.deepEqual(users, ['Split the work', '[s1] done task A\n\n[s2] done task B']);
  assert.equal(lastText(parent.at(-1)), '[s1] done task A\n\n[s2] done task B');
  await chat.close();
});

test('code mode: a subagent cannot spawn, and tell refuses a finished subagent', async () => {
  const chat = await openChat({
    codemode: true,
    respond(context) {
      const message = last(context);
      if (isChild(context)) {
        if (message.role === 'toolResult') return say(textOf(message.content));
        return call('codemode', { code: `try { await tools.spawn({ tasks: ['deeper'] }); text('nested ran'); } catch (e) { text('refused: ' + e.message); }` });
      }
      const text = lastText(context);
      if (message.role === 'toolResult') return say('ok');
      if (text === 'Go') return call('codemode', { code: `text(await tools.spawn({ tasks: ['nest'] }))` });
      if (text === 'Tell it') return call('codemode', { code: `try { await tools.tell({ id: '[s1]', message: 'hi' }); } catch (e) { text(e.message); }` });
      return say('noted');
    },
  });
  await chat.ask('Go');
  const users = await userTexts(chat.root);
  assert.match(users[1], /^\[s1\] refused: spawn: A subagent cannot spawn subagents/);
  await chat.ask('Tell it');
  const result = chat.requests.filter(r => !isChild(r)).at(-1).messages.findLast(m => m.role === 'toolResult');
  assert.match(textOf(result.content), /^tell: \[s1\] has finished/);
  await chat.close();
});

test('tell steers a running subagent between its tool calls', async () => {
  const chat = await openChat({
    codemode: false,
    respond(context) {
      const message = last(context);
      if (isChild(context)) {
        if (message.role === 'user' && lastText(context).includes('Your task:')) return call('bash', { command: 'sleep 1' });
        const heard = context.messages.some(m => m.role === 'user' && textOf(m.content) === 'use blue');
        return say(heard ? 'painted blue' : (message.role === 'user' ? 'noted' : 'painted red'));
      }
      if (message.role === 'toolResult' && message.toolName === 'spawn') return call('tell', { id: 's1', message: 'use blue' });
      if (message.role === 'toolResult') return say(textOf(message.content));
      if (lastText(context).startsWith('[s1]')) return say('Done.');
      return call('spawn', { tasks: ['paint'] });
    },
  });
  await chat.ask('Paint it');
  const tellResult = chat.requests.filter(r => !isChild(r)).flatMap(r => r.messages).find(m => m.role === 'toolResult' && m.toolName === 'tell');
  assert.equal(textOf(tellResult.content), 'Sent to [s1].');
  const users = await userTexts(chat.root);
  assert.equal(users.filter(t => t.startsWith('[s1]')).length, 1, JSON.stringify(users));
  assert.equal(users.at(-1), '[s1] painted blue');
  await chat.close();
});

test('a subagent working when the process stops reports once after the restart', async () => {
  const dir = tmp();
  const file = path.join(dir, 'state.sqlite');
  const models = createModels();
  // 20 tokens per second: the subagent's long answer takes seconds.
  const faux = fauxProvider({ provider: 'chat', api: 'faux-chat', models: [{ id: 'm' }], tokensPerSecond: 20 });
  models.setProvider(faux.provider);
  const route = context => {
    const message = last(context);
    if (isChild(context)) return say(`report ${'word '.repeat(60)}end`);
    if (message.role === 'toolResult') return say('Running.');
    if (lastText(context).startsWith('[s1]')) return say('Got it.');
    return call('spawn', { tasks: ['long task'] });
  };
  faux.setResponses(Array.from({ length: 20 }, () => route));
  const open = async () => {
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(createSubagentExtension());
    const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry, env: () => new NodeExecutionEnv({ cwd: dir }) }, ctx);
    const root = await harness.root(ctx, { agent: { model: { provider: 'chat', modelId: 'm' }, cwd: dir } });
    return { harness, root };
  };
  let { harness, root } = await open();
  await (await root.submit({ type: 'input', content: 'Start it' }, ctx)).wait(ctx);
  const child = (await harness.snapshot(Subagents, root.id, ctx)).agents.s1.conversationId;
  // Stop while the subagent is still answering.
  for (let k = 0; k < 300 && !(await harness.snapshot(LiveDoc, child, ctx))?.run; k++) await new Promise(r => setTimeout(r, 10));
  assert.ok((await harness.snapshot(LiveDoc, child, ctx))?.run, 'subagent is running');
  await harness.close(ctx);
  ({ harness, root } = await open());
  harness.resume();
  await settle(harness, root);
  const users = await userTexts(root);
  assert.equal(users.filter(text => text.startsWith('[s1] ')).length, 1, JSON.stringify(users));
  assert.match(users.at(-1), /^\[s1\] report (word ){60}end$/);
  await harness.close(ctx);
});
