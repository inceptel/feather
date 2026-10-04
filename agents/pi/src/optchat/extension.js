// OptChat inside pi-durable (spec §3, §7).
//
// pi-durable's entry log stays the source of truth for the turn and tool
// loop. The OptChat log is derived from it in entry order (logEntries), and
// every model request of a run sees the same frozen view of the chat before
// the run, then the run itself (the beforeRequest hook). The host resets the
// pi context after each idle run, so pi's own context never grows past one run.
import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import { defineExtension, defineTool, GenerationTask, hook, section } from '@earendil-works/pi-durable';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai/utils/transcript';
import { DATE_DESCRIPTION, MASTER, VIEW_DOC, ZOOM_DESCRIPTION } from './prompts.js';
import { flat, PLACEHOLDER } from './view.js';

export const ECHO_CAP = 30_000;
export const SETTLE_MS = 120_000;
export const TURN_FILE = 'turn.json';
export const TURNS_LOG = 'turns.jsonl';

/** Cap a long tool result, keeping its head and tail. */
export function capText(text, cap = ECHO_CAP) {
  if (text.length <= cap) return text;
  const half = Math.floor((cap - 60) / 2);
  return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters cut …]\n${text.slice(-half)}`;
}

const textOf = content => (typeof content === 'string'
  ? content
  : (content || []).filter(block => block?.type === 'text').map(block => block.text).join('\n'));

/** The OptChat messages one pi-durable entry adds, in order: [{kind, text}]. */
export function entryMessages(entry) {
  const message = entry?.model?.[0];
  if (!message) return [];
  if (entry.kind === 'pi.user') {
    const text = textOf(message.content);
    return text ? [{ kind: 'user', text }] : [];
  }
  if (entry.kind === 'pi.assistant') {
    const out = [];
    const text = textOf(message.content).trim(); // thinking is never logged
    if (text) out.push({ kind: 'talk', text });
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'toolCall') out.push({ kind: 'tool', text: `${block.name} ${JSON.stringify(block.arguments ?? {})}` });
    }
    return out;
  }
  if (entry.kind === 'pi.tool-result') {
    const text = textOf(message.content);
    return [{ kind: 'echo', text: capText(text || (message.isError ? '(error, no output)' : '(no output)')) }];
  }
  return [];
}

/**
 * Log entries in id order. Idempotent: an entry part at or before the last
 * logged (src, part) is skipped. Returns the new message rows.
 */
export function logEntries(store, entries) {
  const added = [];
  let last = store.lastSrc();
  const sorted = [...entries].filter(entry => Number.isFinite(entry?.id)).sort((a, b) => a.id - b.id);
  for (const entry of sorted) {
    if (last && entry.id < last.src) continue;
    const parts = entryMessages(entry);
    for (let part = 0; part < parts.length; part++) {
      if (last && entry.id === last.src && part <= last.part) continue;
      const timestamp = entry.model?.[0]?.timestamp;
      const date = Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
      added.push(store.addMessage(parts[part].kind, parts[part].text, { src: entry.id, part, date }));
      last = { src: entry.id, part };
    }
  }
  return added;
}

/** Entries after the last logged one, oldest first, from the conversation's history. */
export async function unloggedEntries(conversation, store, ctx, pageSize = 200) {
  const last = store.lastSrc();
  const out = [];
  let cursor;
  for (;;) {
    const page = await conversation.entries({}, pageSize, cursor, ctx);
    let done = false;
    for (const entry of page.items) {
      if (last && entry.id < last.src) { done = true; break; }
      out.push(entry);
    }
    if (done || !page.next) break;
    cursor = page.next;
  }
  return out.reverse();
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

const finalAnswer = message => message.role === 'assistant' && !(message.content || []).some(block => block?.type === 'toolCall');

/** Index of the run's first user message: the first after the last final answer. */
export function runStart(messages) {
  let after = -1;
  for (let k = messages.length - 1; k >= 0; k--) if (finalAnswer(messages[k])) { after = k; break; }
  for (let k = after + 1; k < messages.length; k++) if (messages[k].role === 'user') return k;
  return -1;
}

const runKey = message => `${message.timestamp}:${textOf(message.content).length}:${textOf(message.content).slice(0, 200)}`;

/**
 * The extension. `memory` = {store, view, sessionDir, log, note}: `log()`
 * brings the OptChat log up to date; `note(text)` tells the pane. The zoom and
 * date tools are on `extension.memoryTools`; with `offerTools: false` the
 * extension does not offer them itself (code mode calls them instead).
 */
export function createOptChatExtension(memory, { settleMs = SETTLE_MS, offerTools = true } = {}) {
  const { store, view, sessionDir } = memory;
  const turnFile = path.join(sessionDir, TURN_FILE);
  const turnsLog = path.join(sessionDir, TURNS_LOG);
  let frozen = readJson(turnFile);
  let freezing;

  async function freeze(message) {
    const key = runKey(message);
    if (frozen?.key === key) return frozen;
    if (freezing?.key === key) return freezing.promise;
    const promise = (async () => {
      await memory.log();
      // k: the run's user message in the log, else everything logged so far.
      let k = store.messages.length;
      for (let i = store.messages.length - 1; i >= 0; i--) {
        const row = store.messages[i];
        if (row.kind === 'user' && row.text === textOf(message.content)) { k = i; break; }
        if (Date.parse(row.date) < message.timestamp - 60_000) break;
      }
      const started = Date.now();
      const settled = await view.settle(k, { timeoutMs: settleMs });
      if (!settled) memory.note?.('memory: some summaries are not ready; the view shows placeholders (the model can zoom them)');
      const text = view.render(k);
      const turn = { key, k, text, lines: view.partsBefore(k).length, bytes: Buffer.byteLength(text), waitedMs: Date.now() - started, settled };
      writeJsonAtomic(turnFile, turn);
      try {
        const { text: _text, ...record } = turn;
        fs.appendFileSync(turnsLog, `${JSON.stringify({ date: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
      } catch { /* evidence only */ }
      frozen = turn;
      return turn;
    })();
    freezing = { key, promise };
    try { return await promise; } finally { if (freezing?.key === key) freezing = undefined; }
  }

  const zoom = defineTool({
    name: 'zoom',
    description: ZOOM_DESCRIPTION,
    parameters: Type.Object({
      id: Type.Integer({ description: 'First message id of the line' }),
      n: Type.Integer({ description: 'Number of messages the line covers (a power of 2)' }),
    }),
    replay: 'safe',
    async execute({ id, n }) {
      const T = store.messages.length;
      const fail = text => ({ content: [{ type: 'text', text }], isError: true });
      if (!Number.isInteger(n) || n < 1 || (n & (n - 1)) !== 0 || !Number.isInteger(id) || id < 0 || id % n !== 0 || id + n > T) {
        return fail(`No line ${id}+${n}.`);
      }
      if (n === 1) {
        const row = store.messages[id];
        return { content: [{ type: 'text', text: `${id}+0|${row.kind}: ${row.text}` }] };
      }
      const l = Math.log2(n) - 1;
      // A child that is not summarized yet shows the placeholder; zoom it in turn.
      const a = store.node(l, (2 * id) / n)?.text ?? PLACEHOLDER;
      const b = store.node(l, (2 * id) / n + 1)?.text ?? PLACEHOLDER;
      const half = n / 2;
      return { content: [{ type: 'text', text: `${id}+${half}|${flat(a)}\n${id + half}+${half}|${flat(b)}` }] };
    },
  });

  const date = defineTool({
    name: 'date',
    description: DATE_DESCRIPTION,
    parameters: Type.Object({ id: Type.Integer({ description: 'Message id' }) }),
    replay: 'safe',
    async execute({ id }) {
      const row = store.messages[id];
      if (!row) return { content: [{ type: 'text', text: `No message ${id}.` }], isError: true };
      return { content: [{ type: 'text', text: new Date(row.date).toString() }] };
    },
  });

  const extension = defineExtension({
    name: 'optchat',
    tools: offerTools ? [zoom, date] : [],
    sections: [section('optchat', () => `${MASTER}\n\n${VIEW_DOC}`, { tag: false })],
    hooks: [hook(GenerationTask, {
      async beforeRequest({ messages }) {
        const system = getCurrentSystemMessage(messages);
        const rest = messages.filter(message => message.role !== 'system');
        const start = runStart(rest);
        if (start < 0) return undefined;
        const first = rest[start];
        const turn = await freeze(first);
        const content = typeof first.content === 'string' ? [{ type: 'text', text: first.content }] : [...first.content];
        const withView = { ...first, content: [{ type: 'text', text: turn.text }, ...content] };
        return { messages: [...(system ? [system] : []), withView, ...rest.slice(start + 1)] };
      },
    })],
  });
  // frozenView(): the view of the current run, which a spawn hands its subagents.
  return Object.assign(extension, { memoryTools: [zoom, date], frozenView: () => frozen?.text });
}
