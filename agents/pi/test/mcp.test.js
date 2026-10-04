import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing';
import { createCodemodeExtension } from '../src/codemode.js';
import { connectMcpServers, mcpConfigPath, mcpEnabled, openMcp, readMcpConfig, toolName } from '../src/mcp.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mcp-'));
const textOf = content => (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

// A minimal MCP server: initialize, tools/list, tools/call. Shared by the
// in-memory fake and the stdio fake below.
const SERVER = `
function serve(send, tools, call, instructions) {
  return message => {
    if (message.id === undefined) return;
    const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' }, instructions });
    if (message.method === 'tools/list') return reply({ tools });
    if (message.method === 'tools/call') return Promise.resolve(call(message.params.name, message.params.arguments)).then(reply);
    if (message.method === 'ping') return reply({});
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no method' } });
  };
}`;
const serve = new Function(`${SERVER}; return serve;`)();

const ADD = { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } };
const BOOM = { name: 'boom-tool', description: 'Always fails', inputSchema: { type: 'object' } };

function inMemory({ instructions, silent = false } = {}) {
  return () => {
    const { client, server } = createInMemoryTransportPair();
    const handle = serve(message => server.send(message), [ADD, BOOM], (name, args) => (name === 'add'
      ? { content: [{ type: 'text', text: String(args.a + args.b) }] }
      : { content: [{ type: 'text', text: 'it broke' }], isError: true }), instructions);
    if (!silent) server.onMessage(handle);
    void server.start();
    return client;
  };
}

test('MCP is on unless switched off; no config file means no servers', async () => {
  assert.equal(mcpEnabled({}), true);
  assert.equal(mcpEnabled({ FEATHER_PI_MCP: 'off' }), false);
  assert.equal(mcpConfigPath({ FEATHER_PI_MCP_CONFIG: '/x/y.json' }), '/x/y.json');
  assert.match(mcpConfigPath({}), /\.feather\/pi-mcp\.json$/);
  const dir = tmp();
  assert.deepEqual(readMcpConfig(path.join(dir, 'none.json')), []);
  const none = await openMcp({ env: { FEATHER_PI_MCP_CONFIG: path.join(dir, 'none.json') } });
  assert.deepEqual(none.tools, []);
  // Off ignores a config that would fail.
  fs.writeFileSync(path.join(dir, 'bad.json'), '{"mcpServers":{"x":{}}}');
  const off = await openMcp({ env: { FEATHER_PI_MCP: 'off', FEATHER_PI_MCP_CONFIG: path.join(dir, 'bad.json') } });
  assert.deepEqual(off.tools, []);
  // A bad config is reported, not fatal.
  const heard = [];
  const bad = await openMcp({ env: { FEATHER_PI_MCP_CONFIG: path.join(dir, 'bad.json') }, report: t => heard.push(t) });
  assert.deepEqual(bad.tools, []);
  assert.match(heard[0], /server "x" needs "command" or "url"/);
});

test('config: Claude-style mcpServers, disabled entries, names', () => {
  const dir = tmp();
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: {
    executor: { command: 'executor', args: ['mcp', 1], env: { A: 2 } },
    remote: { url: 'https://h/mcp', headers: { X: 'y' } },
    old: { command: 'x', disabled: true },
  } }));
  assert.deepEqual(readMcpConfig(file), [
    { name: 'executor', command: 'executor', args: ['mcp', '1'], env: { A: '2' }, cwd: undefined },
    { name: 'remote', url: 'https://h/mcp', headers: { X: 'y' } },
  ]);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'bad name': { command: 'x' } } }));
  assert.throws(() => readMcpConfig(file), /bad server name/);
  assert.equal(toolName('executor', 'execute'), 'executor_execute');
  assert.equal(toolName('my-srv', 'search.tools/v2'), 'my_srv_search_tools_v2');
  assert.equal(toolName('s', 'x'.repeat(100)).length, 64);
});

test('tools: named per server, instructions on the first, errors kept, a silent server skipped', async () => {
  const heard = [];
  const mcp = await connectMcpServers([{ name: 'fake' }, { name: 'dead' }], {
    report: t => heard.push(t),
    timeoutMs: 300,
    transport: server => inMemory({ instructions: 'Call add for sums.', silent: server.name === 'dead' })(),
  });
  assert.deepEqual(mcp.tools.map(t => t.name), ['fake_add', 'fake_boom_tool']);
  assert.equal(mcp.summary, 'fake (2 tools)');
  assert.match(mcp.tools[0].description, /^\(MCP server "fake"\) Add two numbers\n\nServer instructions:\nCall add for sums\.$/);
  assert.doesNotMatch(mcp.tools[1].description, /Server instructions/);
  assert.match(heard.join('\n'), /mcp: dead skipped: no answer in 0\.3 s/);
  const sum = await mcp.tools[0].execute({ a: 2, b: 3 }, {}, undefined);
  assert.deepEqual(sum, { content: [{ type: 'text', text: '5' }], isError: false });
  const boom = await mcp.tools[1].execute({}, {}, undefined);
  assert.equal(boom.isError, true);
  assert.equal(textOf(boom.content), 'it broke');
  await mcp.close();
});

test('code mode scripts call MCP tools, with schema checks', async () => {
  const mcp = await connectMcpServers([{ name: 'fake' }], { transport: inMemory() });
  const faux = fauxProvider({ provider: 'chat', api: 'faux-chat', models: [{ id: 'm' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const results = [];
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall('codemode', { code: `text(await tools.fake_add({ a: 40, b: 2 })); try { await tools.fake_add({ a: 'x' }); } catch (e) { text('bad: ' + e.message); }` }), { stopReason: 'toolUse' }),
    context => { results.push(context.messages.at(-1)); return fauxAssistantMessage(fauxText('done')); },
  ]);
  const registry = createRegistry();
  registry.install(createCodemodeExtension(mcp.tools));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => new NodeExecutionEnv({ cwd: tmp() }) }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: 'chat', modelId: 'm' } } });
  await (await root.submit({ type: 'input', content: 'sum' }, ctx)).wait(ctx);
  assert.match(textOf(results[0].content), /^42\nbad: fake_add: invalid arguments: .*(required|b)/);
  await harness.close(ctx);
  await mcp.close();
});

test('a stdio server gets a clean env: no bridge token or other secrets', { timeout: 30_000 }, async () => {
  const dir = tmp();
  const script = path.join(dir, 'server.cjs');
  fs.writeFileSync(script, `${SERVER}
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
const tool = { name: 'env', description: 'env keys', inputSchema: { type: 'object' } };
const handle = serve(send, [tool], () => ({ content: [{ type: 'text', text: Object.keys(process.env).sort().join(',') }] }));
let buf = '';
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); } });
`);
  const config = path.join(dir, 'mcp.json');
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [script], env: { MINE: '1' } } } }));
  const mcp = await openMcp({ env: { ...process.env, FEATHER_PI_MCP_CONFIG: config, FEATHER_BRIDGE_TOKEN: 'secret-token', OPENROUTER_API_KEY: 'k' } });
  assert.deepEqual(mcp.tools.map(t => t.name), ['local_env']);
  const keys = textOf((await mcp.tools[0].execute({}, {}, undefined)).content).split(',');
  assert.ok(keys.includes('MINE') && keys.includes('PATH'), keys.join(','));
  for (const key of keys) assert.match(key, /^(MINE|PATH|HOME|USER|LOGNAME|LANG|LC_ALL|TZ|TMPDIR)$/, key);
  await mcp.close();
});
