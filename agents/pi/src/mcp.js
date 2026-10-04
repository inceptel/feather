// MCP servers as pi tools (spec: pi-optchat-agent.md, phase 5). The target is
// Rhys Sullivan's executor (`executor mcp`), which keeps integration
// credentials on its side and serves one `execute` tool; any MCP server works.
//
// Servers are listed in ~/.feather/pi-mcp.json (FEATHER_PI_MCP_CONFIG moves
// it), in Claude's shape:
//
//   { "mcpServers": {
//       "executor": { "command": "executor", "args": ["mcp"], "env": {} },
//       "remote":   { "url": "https://host/mcp", "headers": {} } } }
//
// No file means no MCP. FEATHER_PI_MCP=off ignores the file. Each tool becomes
// `<server>_<tool>`. A stdio server gets PATH, HOME, USER, LANG and its own
// `env` only, never Feather's bridge token or other secrets of this process.
// A server that fails to start is skipped; the chat still runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-durable';
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp';

export const MCP_CONNECT_TIMEOUT_MS = 20_000;
export const MCP_CALL_TIMEOUT_MS = 300_000;
export const MCP_INSTRUCTIONS_CHARS = 2_000;
const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'];

export function mcpEnabled(env = process.env) {
  return !/^(0|off|false|no)$/i.test(String(env.FEATHER_PI_MCP ?? '').trim());
}

export function mcpConfigPath(env = process.env) {
  return env.FEATHER_PI_MCP_CONFIG || path.join(os.homedir(), '.feather', 'pi-mcp.json');
}

/** A name the model can write as `tools.<name>`: letters, digits and _, at most 64. */
export function toolName(server, tool) {
  const name = `${server}_${tool}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
  return /^[A-Za-z_]/.test(name) ? name : `_${name.slice(0, 63)}`;
}

/** The servers in `file`: [{name, command, args, env, cwd} | {name, url, headers}]. A missing file is no servers. */
export function readMcpConfig(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const servers = JSON.parse(raw)?.mcpServers;
  if (!servers || typeof servers !== 'object') throw new Error(`${file}: no "mcpServers" object`);
  const list = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name)) throw new Error(`${file}: bad server name "${name.slice(0, 40)}"`);
    if (entry?.disabled) continue;
    if (typeof entry?.url === 'string') {
      list.push({ name, url: entry.url, headers: stringMap(entry.headers) });
    } else if (typeof entry?.command === 'string') {
      list.push({
        name,
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: stringMap(entry.env),
        cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
      });
    } else {
      throw new Error(`${file}: server "${name}" needs "command" or "url"`);
    }
  }
  return list;
}

function stringMap(value) {
  const out = {};
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) out[key] = String(item);
  return out;
}

function transportFor(server, env) {
  if (server.url) return new StreamableHttpTransport({ url: server.url, headers: server.headers });
  const passed = {};
  for (const key of PASSED_ENV) if (env[key]) passed[key] = env[key];
  return new StdioTransport({
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    env: { ...passed, ...server.env },
    inheritEnv: false,
    stderr: 'pipe',
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** One MCP tool as a pi-durable tool. MCP reports a tool failure in the result, not as an error. */
export function mcpTool(server, client, tool, { extra = '' } = {}) {
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : {};
  return defineTool({
    name: toolName(server, tool.name),
    description: [`(MCP server "${server}") ${tool.description || tool.title || tool.name}`, extra].filter(Boolean).join('\n\n'),
    // Providers need an object schema with properties.
    parameters: Type.Unsafe({ ...schema, type: 'object', properties: schema.properties ?? {} }),
    async execute(args, _api, context) {
      let result;
      try {
        result = await client.callTool(tool.name, args ?? {}, { signal: context?.abortSignal, timeoutMs: MCP_CALL_TIMEOUT_MS });
      } catch (error) {
        return { content: [{ type: 'text', text: `${server}: ${String(error?.message || error).slice(0, 1000)}` }], isError: true };
      }
      const content = toLlmContent(result);
      return { content: content.length ? content : [{ type: 'text', text: '(no content)' }], isError: result.isError === true };
    },
  });
}

/**
 * Connect every server in `servers`; resolve to {tools, summary, close}.
 * `report(text)` hears about servers that fail; they are left out.
 */
export async function connectMcpServers(servers, { env = process.env, report = () => {}, timeoutMs = MCP_CONNECT_TIMEOUT_MS, transport = transportFor } = {}) {
  const clients = [];
  const tools = [];
  const summary = [];
  await Promise.all(servers.map(async server => {
    const client = new McpClient({ name: 'feather-pi', version: '1.0.0' });
    const link = transport(server, env);
    try {
      await withTimeout(client.connect(link), timeoutMs, `no answer in ${timeoutMs / 1000} s`);
      const listed = await withTimeout(client.listTools(), timeoutMs, `no tool list in ${timeoutMs / 1000} s`);
      clients.push(client);
      // The server's own instructions go with its first tool.
      const extra = client.instructions ? `Server instructions:\n${client.instructions.slice(0, MCP_INSTRUCTIONS_CHARS)}` : '';
      listed.forEach((tool, index) => tools.push(mcpTool(server.name, client, tool, { extra: index === 0 ? extra : '' })));
      summary.push(`${server.name} (${listed.length} tools)`);
    } catch (error) {
      // Not the server's stderr: it could hold a secret.
      report(`mcp: ${server.name} skipped: ${String(error?.message || error).slice(0, 300)}`);
      await client.close().catch(() => {});
    }
  }));
  const names = new Set();
  const unique = tools.filter(tool => (names.has(tool.name) ? false : names.add(tool.name)));
  return {
    tools: unique,
    summary: summary.sort().join(', '),
    async close() { await Promise.all(clients.map(client => client.close().catch(() => {}))); },
  };
}

/** The configured servers, connected; no servers (and no error) when MCP is off or not set up. */
export async function openMcp({ env = process.env, report = () => {}, ...options } = {}) {
  const empty = { tools: [], summary: '', close: async () => {} };
  if (!mcpEnabled(env)) return empty;
  let servers;
  try { servers = readMcpConfig(mcpConfigPath(env)); } catch (error) {
    report(`mcp: config not used: ${String(error?.message || error).slice(0, 300)}`);
    return empty;
  }
  if (!servers.length) return empty;
  return connectMcpServers(servers, { env, report, ...options });
}
