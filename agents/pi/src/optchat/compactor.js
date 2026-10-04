// The OptChat compactor (spec §4): a background pump that builds tree nodes
// with a cheap model, in strict order. A node starts only when its sources
// exist and every view line before its end is a built summary, so messages
// are compressed one at a time, in order, while merges run alongside.
import { COMPACT, SCALE } from './prompts.js';
import { bytes } from './store.js';
import { NODE, flat } from './view.js';

export const JOBS = 8;
export const TRIES = 5;
export const RETRY_MS = 10_000;

/** Cut `text` to its first `limit` UTF-8 bytes without splitting a character. */
export function cutBytes(text, limit) {
  return Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8').replace(/�$/, '');
}

/**
 * `complete(messages, signal)` runs one model call (pi-ai messages, no tools)
 * and resolves the assistant message; `model` names it for the tree row.
 */
export function createCompactor({ store, view, complete, model = undefined, jobs = JOBS, tries = TRIES, retryMs = RETRY_MS, report = () => {} }) {
  const busy = new Set();
  const failed = new Set();
  const controller = new AbortController();
  let stopped = false;
  const listeners = new Set();

  const key = (l, i) => `${l}:${i}`;
  const ready = (l, i) => (l === 0 ? i < store.messages.length : view.built(l - 1, 2 * i) && view.built(l - 1, 2 * i + 1));

  function pump() {
    if (stopped) return;
    const T = store.messages.length;
    const first = view.first();
    for (let l = 0; 2 ** l <= T; l++) {
      for (let i = 0; (i + 1) * 2 ** l <= T; i++) {
        if (busy.size >= jobs) return;
        const end = l === 0 ? i : (i + 1) * 2 ** l;
        if (end > first) break; // later nodes of this level end later still
        if (view.built(l, i) || busy.has(key(l, i)) || !ready(l, i)) continue;
        busy.add(key(l, i));
        build(l, i).then(
          () => { busy.delete(key(l, i)); failed.delete(key(l, i)); pump(); },
          error => {
            if (stopped) return;
            if (!failed.has(key(l, i))) {
              failed.add(key(l, i));
              report(`memory: node ${2 ** l * i}+${2 ** l} failed (retrying every ${retryMs / 1000}s): ${String(error?.message || error).slice(0, 200)}`);
            }
            setTimeout(() => { busy.delete(key(l, i)); pump(); }, retryMs).unref?.();
          },
        );
      }
    }
  }

  async function build(l, i) {
    await null; // always asynchronous, so pump() never re-enters itself
    let source;
    let step;
    let contextEnd;
    if (l === 0) {
      const message = store.messages[i];
      source = `${message.kind}: ${message.text}`;
      step = `Compress this message into one line, in at most ${NODE} bytes:\n${source}`;
      contextEnd = i;
    } else {
      const a = store.node(l - 1, 2 * i).text;
      const b = store.node(l - 1, 2 * i + 1).text;
      source = `${a}\n${b}`;
      step = `Merge these two lines into one, in at most ${NODE} bytes:\n${flat(a)}\n${flat(b)}`;
      contextEnd = (i + 1) * 2 ** l;
    }
    if (bytes(source) <= NODE) { save(l, i, source); return; } // a free node
    const messages = [
      { role: 'system', content: COMPACT, timestamp: 0 },
      {
        role: 'user',
        content: [
          { type: 'text', text: view.bare(contextEnd) },
          { type: 'text', text: `For scale only, this sample line is exactly ${NODE} bytes:\n${SCALE}\n\n${step}` },
        ],
        timestamp: Date.now(),
      },
    ];
    const attempts = [];
    for (;;) {
      const reply = await complete(messages, controller.signal);
      if (stopped) throw new Error('compactor stopped');
      const line = replyText(reply).trim();
      if (!line) throw new Error(reply?.errorMessage || `empty reply (${reply?.stopReason || 'no stop reason'})`);
      attempts.push(line);
      if (bytes(line) <= NODE || attempts.length >= tries) break;
      messages.push(reply, {
        role: 'user',
        content: `That line is ${bytes(line)} bytes; the limit is ${NODE}. It must end where it is cut here:\n${cutBytes(line, NODE)}| ← LIMIT`,
        timestamp: Date.now(),
      });
    }
    const shortest = attempts.reduce((a, b) => (bytes(b) < bytes(a) ? b : a));
    save(l, i, shortest, model ? { model } : {});
  }

  function save(l, i, text, extra = {}) {
    if (stopped) return;
    store.addNode(l, i, text, extra);
    view.fit();
    for (const listener of listeners) listener(l, i);
  }

  return {
    pump,
    busy: () => busy.size,
    onBuilt(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    stop() { stopped = true; controller.abort(); },
  };
}

function replyText(message) {
  if (!message || message.stopReason === 'error' || message.stopReason === 'aborted') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  return (content || []).filter(block => block?.type === 'text').map(block => block.text).join('');
}
