// The pi agent's OptChat memory: the log, tree and view in the session dir,
// the compactor that builds the tree, and the extension that shows the view.
// FEATHER_PI_MEMORY=off turns it off; the chat is then a plain pi chat.
import fs from 'node:fs';
import { openStore } from './store.js';
import { createView } from './view.js';
import { createCompactor } from './compactor.js';
import { createOptChatExtension, logEntries, unloggedEntries } from './extension.js';

// Codex luna through the gateway: a subscription, so no paid credits run out
// (OpenRouter returned 402 in the phase 2 live check). Gemini 3.6 flash was
// faster in the probe; set FEATHER_PI_COMPACTOR_MODEL to use it.
export const DEFAULT_COMPACTOR_MODEL = 'openai-codex/gpt-5.6-luna';

export function memoryEnabled(env = process.env) {
  return !/^(0|off|false|no)$/i.test(String(env.FEATHER_PI_MEMORY ?? '').trim());
}

export function compactorModelRef(env = process.env) {
  return String(env.FEATHER_PI_COMPACTOR_MODEL || '').trim() || DEFAULT_COMPACTOR_MODEL;
}

/** One model call with no tools; resolves the assistant message. */
export function modelCompleter(models, ref) {
  const model = models.getModel(ref.provider, ref.modelId);
  if (!model) throw new Error(`unknown compactor model: ${ref.provider}/${ref.modelId}`);
  return async (messages, signal) => {
    const events = models.streamSimple(model, { messages }, { signal, ...(model.reasoning ? { reasoning: 'medium' } : {}) });
    return await events.result();
  };
}

/**
 * Open the memory in `sessionDir`. `complete` runs compactor calls and
 * `modelName` names the compactor in tree rows.
 */
export function openMemory({ sessionDir, complete, modelName, report = () => {}, budget, settleMs, offerTools = true }) {
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const store = openStore(sessionDir, { report });
  const view = createView(store, budget ? { budget } : {});
  view.fold();
  const compactor = createCompactor({ store, view, complete, model: modelName, report });
  let conversation;
  let ctx;
  let logging = Promise.resolve();

  function add(entries) {
    const rows = logEntries(store, entries);
    for (const row of rows) view.append(row.i);
    if (rows.length) compactor.pump();
    return rows;
  }

  const memory = {
    store,
    view,
    compactor,
    sessionDir,
    note: report,
    /** Bring the log up to date with the conversation's entry history. */
    log() {
      logging = logging.then(async () => {
        if (!conversation) return;
        add(await unloggedEntries(conversation, store, ctx));
      }).catch(error => report(`memory: logging failed: ${error.message}`));
      return logging;
    },
    /** Log entries seen in the event stream (in id order, idempotent). */
    logEntries(entries) {
      logging = logging.then(() => { add(entries); }).catch(error => report(`memory: logging failed: ${error.message}`));
      return logging;
    },
    /** Add a `note` message, such as an imported line. */
    addNote(text, date) {
      const row = store.addMessage('note', text, date ? { date } : {});
      view.append(row.i);
      compactor.pump();
      return row;
    },
    attach(handle, context) {
      conversation = handle;
      ctx = context;
      compactor.pump();
      return memory.log();
    },
    stop() { compactor.stop(); },
  };
  memory.extension = createOptChatExtension(memory, { ...(settleMs ? { settleMs } : {}), offerTools });
  memory.tools = memory.extension.memoryTools;
  return memory;
}
