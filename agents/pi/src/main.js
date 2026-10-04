#!/usr/bin/env node
// Feather's pi agent: one durable pi-durable conversation per Feather chat,
// running in the chat's tmux pane.
//
//   node src/main.js --session-id <id> --session-dir <dir> --cwd <dir>
//                    [--model <ref>] [--system-prompt-file <file>]
//
// State lives in <session-dir>/state.sqlite. A killed process loses nothing
// that was committed: on restart pi-durable resumes the interrupted run, and
// transcript.jsonl is re-derived from the entry log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createRegistry, Harness, LiveDoc, watchEvents } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createAgentModels, defaultModelRef, parseModelRef, readKeyvaultKey } from './models.js';
import { createInputParser } from './input.js';
import { createTranscript } from './transcript.js';
import { createBridgeClient, createEventMapper, sessionStateEvent } from './bridge.js';
import { acquireSessionLock } from './lock.js';
import { compactorModelRef, memoryEnabled, modelCompleter, openMemory } from './optchat/memory.js';

const { values: args } = parseArgs({
  options: {
    'session-id': { type: 'string' },
    'session-dir': { type: 'string' },
    cwd: { type: 'string' },
    model: { type: 'string' },
    'system-prompt-file': { type: 'string' },
  },
  strict: true,
});

const sessionId = args['session-id'];
const sessionDir = args['session-dir'];
if (!sessionId || !sessionDir) {
  process.stderr.write('usage: main.js --session-id <id> --session-dir <dir> [--cwd <dir>] [--model <ref>] [--system-prompt-file <file>]\n');
  process.exit(2);
}
const cwd = path.resolve(args.cwd || os.homedir());
fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

process.stdout.on('error', () => {}); // the pane can close first
const out = text => { try { process.stdout.write(text); } catch { /* pane gone */ } };
const note = text => out(`\x1b[2m${text}\x1b[0m\r\n`);

function readInstructions() {
  const file = args['system-prompt-file'];
  if (!file) return undefined;
  try { return fs.readFileSync(file, 'utf8').trim() || undefined; } catch { return undefined; }
}

// Feather passes the bridge capability in the env, as it does for Claude and
// Codex. The shell keeps it too: Feather tools (links, rename) use it.
const bridge = createBridgeClient({
  url: process.env.FEATHER_BRIDGE_URL || '',
  token: process.env.FEATHER_BRIDGE_TOKEN,
});

const lock = await acquireSessionLock(sessionDir).catch(error => {
  process.stderr.write(`pi: ${error.message}\n`);
  process.exit(error.code === 'ELOCKED' ? 3 : 1);
});

const keyvault = process.env.FEATHER_PI_KEYVAULT || path.join(os.homedir(), 'keyvault.txt');
const openrouterKey = process.env.OPENROUTER_API_KEY || readKeyvaultKey(keyvault, 'OPENROUTER_API_KEY');
delete process.env.OPENROUTER_API_KEY;
const memoryOn = memoryEnabled();
const { models, ensure } = createAgentModels({ secrets: openrouterKey ? { OPENROUTER_API_KEY: openrouterKey } : {}, viewMarks: memoryOn });

const initialRef = parseModelRef(args.model)?.ref || defaultModelRef();

// OptChat memory (spec: pi-optchat-agent.md). A cheap model builds the
// summaries; without it (say, no OpenRouter key) the chat's own model does.
let memory;
if (memoryOn) {
  let compactorRef = compactorModelRef();
  let compactor;
  try { compactor = ensure(compactorRef); } catch (error) {
    note(`memory: compactor ${compactorRef} unavailable (${error.message}); using ${initialRef}`);
    compactorRef = initialRef;
    compactor = ensure(initialRef);
  }
  memory = openMemory({ sessionDir, complete: modelCompleter(models, compactor), modelName: compactorRef, report: note });
}

const registry = createRegistry();
if (memory) registry.install(memory.extension);
registry.install(CodingTools);

const storage = await openNodeSqliteStorage(path.join(sessionDir, 'state.sqlite'));
const harness = await Harness.open(storage, {
  models,
  registry,
  env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir || cwd }),
}, ctx);

// The chat's model is chosen once, at creation (Feather's --model, else the
// FEATHER_PI_DEFAULT_MODEL default), and kept in pi.agent. /model changes it.
const root = await harness.root(ctx, { agent: { model: ensure(initialRef), cwd, instructions: readInstructions() ?? null } });
const agent = await root.agent(ctx);
let currentRef = agent.model ? (agent.model.provider === 'gateway' ? agent.model.modelId : `${agent.model.provider}/${agent.model.modelId}`) : initialRef;
ensure(currentRef);
// Keep the system prompt current with Feather's file on every start.
const instructions = readInstructions();
if (instructions !== undefined && instructions !== agent.instructions) await root.configure({ instructions }, ctx);

const transcript = createTranscript(sessionDir);
const mapper = createEventMapper({ emit: events => bridge.post(events) });
const stream = await watchEvents(harness, root.id, ctx);
transcript.append(stream.snapshot.entries);
if (memory) void memory.attach(root, ctx);
bridge.post([sessionStateEvent(currentRef)]);

let streamingText = false;
// Batches are handled strictly in order: a batch that waits for the bridge
// must not let a later batch write its transcript lines first.
let streamQueue = Promise.resolve();
stream.start(events => {
  streamQueue = streamQueue.then(() => handleEvents(events)).catch(error => note(`pi: event handling failed: ${error.message}`));
});

async function handleEvents(events) {
  const entries = [];
  for (const event of events) {
    if (event.type === 'entry_appended' || event.type === 'message_end' || event.type === 'tool_execution_end') {
      if (event.entry) entries.push(event.entry);
    }
    if (event.type === 'snapshot') entries.push(...event.entries);
  }
  // Live events go first, as OMP does. The chat view drops the live bubble
  // when the transcript message arrives; a final snapshot that arrives after
  // that message would show the answer twice.
  mapper.handleBatch(events);
  if (events.some(event => event.type === 'message_end')) await bridge.drained();
  try { transcript.append(entries); } catch (error) { note(`pi: transcript write failed: ${error.message}`); }
  if (memory && entries.length) void memory.logEntries(entries);
  if (memory && events.some(event => event.type === 'run_end')) resetWhenIdle();
  for (const event of events) render(event);
}

function render(event) {
  switch (event.type) {
    case 'message_update':
      for (const change of event.changes || []) {
        if (change.type === 'text_delta') { out(change.delta.replace(/\r?\n/g, '\r\n')); streamingText = true; }
      }
      break;
    case 'message_end': {
      const message = event.entry?.model?.[0];
      if (!streamingText && message?.role === 'assistant' && Array.isArray(message.content)) {
        const text = message.content.filter(block => block?.type === 'text').map(block => block.text).join('');
        if (text) out(text.replace(/\r?\n/g, '\r\n'));
        streamingText = !!text;
      }
      if (streamingText) out('\r\n');
      streamingText = false;
      break;
    }
    case 'run_start':
      out('\r\n');
      break;
    case 'tool_execution_start':
      note(`• ${event.toolName}`);
      break;
    case 'auto_retry_start':
      note(`retrying (attempt ${event.attempt}): ${String(event.errorMessage).slice(0, 200)}`);
      break;
    case 'task_failed':
      note(`failed: ${String(event.message).slice(0, 300)}`);
      break;
    case 'run_end':
      out('\r\npi> ');
      break;
    default:
      break;
  }
}

// After a run, start a new pi context: the memory view carries the chat, so
// pi's own context holds one run at most and its compaction never has to run.
// Only when idle: a reset placed inside a run would end that run.
function resetWhenIdle() {
  queue = queue.then(async () => {
    await memory.log();
    const live = await harness.documentState(LiveDoc, root.id, ctx);
    const busy = !!live?.value?.run;
    live?.dispose();
    if (!busy) await root.reset(undefined, ctx);
  }).catch(error => note(`memory: context reset failed: ${error.message}`));
}

async function memoryCommand(command, value) {
  if (!memory) { note('memory is off (FEATHER_PI_MEMORY=off)'); return; }
  if (command === '/view') {
    const T = memory.store.messages.length;
    note(`view: ${memory.view.parts.length} lines, ${memory.view.size()} bytes, ${T} messages, first unsummarized ${memory.view.first()}`);
    out(memory.view.render().replace(/\r?\n/g, '\r\n') + '\r\n');
    return;
  }
  // /import <file>: append each line of a JSONL file ({text} or a string) as a note.
  let count = 0;
  try {
    for (const raw of fs.readFileSync(path.resolve(cwd, value || ''), 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      const row = JSON.parse(raw);
      const text = typeof row === 'string' ? row : row?.text;
      if (typeof text !== 'string' || !text) continue;
      memory.addNote(text, row?.date ? new Date(row.date) : undefined);
      count++;
    }
    note(`imported ${count} notes`);
  } catch (error) {
    note(`import stopped after ${count} notes: ${error.message}`);
  }
}

async function handleCommand(text) {
  const [command, value] = text.split(/\s+/, 2);
  if (command === '/view' || command === '/import') { await memoryCommand(command, value); return true; }
  if (command !== '/model') return false;
  if (!value) { note(`model: ${currentRef}`); return true; }
  const parsed = parseModelRef(value);
  if (!parsed) { note(`invalid model: ${value.slice(0, 80)}`); return true; }
  try {
    await root.configure({ model: ensure(parsed.ref) }, ctx);
    currentRef = parsed.ref;
    bridge.post([sessionStateEvent(currentRef)]);
    note(`model set to ${currentRef}`);
  } catch (error) {
    note(`could not set model: ${error.message}`);
  }
  return true;
}

let queue = Promise.resolve();
function submit(text) {
  queue = queue.then(async () => {
    if (await handleCommand(text)) { out('pi> '); return; }
    const submission = await root.submit({ type: 'input', content: text, whenBusy: 'steer' }, ctx);
    void submission.wait(ctx).then(result => {
      if (result.status !== 'done') note(`turn ${result.status}${result.reason ? `: ${result.reason}` : ''}`);
    }, error => note(`turn failed: ${error.message}`));
  }).catch(error => note(`pi: could not submit: ${error.message}`));
}

const parser = createInputParser({
  onSubmit: submit,
  onInterrupt: () => { void root.abort(ctx).catch(error => note(`pi: abort failed: ${error.message}`)); },
  onEcho: out,
});

let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  out('\x1b[?2004l');
  try { await stream.stop(); } catch {}
  memory?.stop();
  try { await harness.close(ctx); } catch {}
  bridge.close();
  await lock.release().catch(() => {});
  process.exit(code);
}
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGHUP', () => void shutdown(0));

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => parser.feed(chunk));
process.stdin.on('end', () => void shutdown(0));
out('\x1b[?2004h');
note(`pi agent · ${currentRef} · ${cwd}${memory ? ` · memory ${memory.store.messages.length} messages` : ''}`);
out('pi> ');

// Continue any run a killed process left behind.
harness.resume();
