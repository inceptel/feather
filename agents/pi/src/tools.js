// Tools the pi agent adds to pi-durable's coding tools: web_fetch, and the
// Feather actions rename_chat and chat_link. Feather passes its URL, the chat
// id and the bridge token in the env (server.js sessionBridgeEnv). The token
// goes only into the request header; no result or error ever shows it.
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-durable';

export const FETCH_CHARS = 50_000;
export const FETCH_MAX_CHARS = 200_000;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_BYTES = 5_000_000;
const TITLE_MAX = 80;

const text = value => ({ content: [{ type: 'text', text: value }] });
const fail = value => ({ content: [{ type: 'text', text: value }], isError: true });

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Plain text of an HTML page: no scripts, styles or tags; one blank line between blocks. */
export function htmlText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/header|\/footer|\/pre|\/blockquote)\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readCapped(response, limit) {
  const reader = response.body?.getReader?.();
  if (!reader) return { buffer: Buffer.from(await response.arrayBuffer()).subarray(0, limit), cut: false };
  const chunks = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= limit) { cut = true; await reader.cancel().catch(() => {}); break; }
  }
  return { buffer: Buffer.concat(chunks).subarray(0, limit), cut };
}

export function createWebFetchTool({ fetchImpl = globalThis.fetch } = {}) {
  return defineTool({
    name: 'web_fetch',
    description: 'Fetch a web page or file over http(s) with GET and return its text. HTML is turned into plain text. Long pages are cut at max_chars (default 50000, at most 200000).',
    parameters: Type.Object({
      url: Type.String({ description: 'An http:// or https:// URL' }),
      max_chars: Type.Optional(Type.Integer({ description: 'Characters to return, 1000 to 200000' })),
    }),
    replay: 'safe',
    async execute({ url, max_chars: maxChars }, _api, context) {
      let target;
      try { target = new URL(url); } catch { return fail(`Not a URL: ${String(url).slice(0, 200)}`); }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return fail('Only http and https URLs can be fetched.');
      const cap = Math.min(FETCH_MAX_CHARS, Math.max(1_000, Number.isInteger(maxChars) ? maxChars : FETCH_CHARS));
      const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS), context?.abortSignal].filter(Boolean);
      let response;
      try {
        response = await fetchImpl(target, {
          redirect: 'follow',
          signal: AbortSignal.any(signals),
          headers: { 'User-Agent': 'Feather-pi-agent/1 (+web_fetch)', Accept: 'text/html,text/plain,application/json,*/*;q=0.5' },
        });
      } catch (error) {
        return fail(`Fetch failed: ${String(error?.message || error).slice(0, 300)}`);
      }
      const type = response.headers.get('content-type') || '';
      const { buffer, cut } = await readCapped(response, FETCH_MAX_BYTES);
      const head = `HTTP ${response.status} ${response.url || target.href}\ncontent-type: ${type || 'unknown'}\n\n`;
      if (type && !/^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json|rss\+xml|atom\+xml))|\+json|\+xml/i.test(type)) {
        return text(`${head}(binary content, ${buffer.length}${cut ? '+' : ''} bytes; not shown)`);
      }
      let body = buffer.toString('utf8');
      if (/html/i.test(type) || (!type && /^\s*<(!doctype html|html)\b/i.test(body))) body = htmlText(body);
      const more = body.length > cap || cut;
      body = body.slice(0, cap);
      const result = `${head}${body}${more ? `\n\n[cut at ${cap} characters]` : ''}`;
      return response.ok ? text(result) : fail(result);
    },
  });
}

/** The bridge settings from Feather's env, or null when the chat runs outside Feather. */
export function featherBridge(env = process.env) {
  const sessionId = String(env.FEATHER_SESSION_ID || '').trim();
  let baseUrl = String(env.FEATHER_URL || '').trim();
  if (!baseUrl && env.FEATHER_BRIDGE_URL) {
    try { baseUrl = new URL(env.FEATHER_BRIDGE_URL).origin; } catch { baseUrl = ''; }
  }
  if (!sessionId || !baseUrl) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), sessionId, token: env.FEATHER_BRIDGE_TOKEN || '' };
}

export function createFeatherTools(bridge, { fetchImpl = globalThis.fetch } = {}) {
  async function post(pathname, body, headers = {}) {
    if (!bridge) throw new Error('This chat is not connected to Feather.');
    const response = await fetchImpl(`${bridge.baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { text: raw.slice(0, 500) }; }
    if (!response.ok) throw new Error(`Feather said ${response.status}: ${String(data?.error || data?.text || '').slice(0, 300)}`);
    return data;
  }

  const renameChat = defineTool({
    name: 'rename_chat',
    description: 'Rename this Feather chat. Use a short plain title, 3 to 7 words, at most 80 characters, with no secrets.',
    parameters: Type.Object({ title: Type.String({ description: 'The new chat title' }) }),
    async execute({ title }) {
      const clean = String(title).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
      if (!clean) return fail('The title is empty.');
      try {
        await post(`/api/sessions/${encodeURIComponent(bridge?.sessionId || '')}/rename`, { title: clean });
        return text(`Chat renamed to "${clean}".`);
      } catch (error) {
        return fail(`Rename failed: ${error.message}`);
      }
    },
  });

  const chatLink = defineTool({
    name: 'chat_link',
    description: "Manage this chat's Links tab in Feather. action \"add\" adds or updates a link (label and target: an absolute file path or an https URL; front: true makes a file the chat's front page). \"remove\" removes the link with that target. \"clear-front\" unsets the front page. \"read\" lists the links.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal('add'), Type.Literal('remove'), Type.Literal('read'), Type.Literal('clear-front')]),
      label: Type.Optional(Type.String()),
      target: Type.Optional(Type.String()),
      front: Type.Optional(Type.Boolean()),
    }),
    async execute({ action, label, target, front }) {
      if (!bridge?.token) return fail('This chat has no Feather bridge capability.');
      const body = { action };
      if (label !== undefined) body.label = label;
      if (target !== undefined) body.target = target;
      if (front !== undefined) body.front = front;
      try {
        const data = await post(`/api/internal/sessions/${encodeURIComponent(bridge.sessionId)}/links`, body, { 'X-Feather-Bridge-Token': bridge.token });
        return text(JSON.stringify(data));
      } catch (error) {
        return fail(`Links ${action} failed: ${error.message}`);
      }
    },
  });

  return [renameChat, chatLink];
}
