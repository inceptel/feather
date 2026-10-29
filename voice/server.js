// voice-web: Feather voice page. The browser talks to OpenAI Realtime over WebRTC;
// this server mints short-lived Realtime keys and runs a small pool of warm agent
// workers (pi in RPC mode). The voice model only knows them as "Feather": each
// ask_feather call becomes a numbered task, and tasks run in parallel.
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const PORT = Number(process.env.PORT) || 4930;
const HOME = process.env.HOME || '/home/user';
const DIR = new URL('.', import.meta.url).pathname;
const MODEL = process.env.VOICE_MODEL || 'gpt-realtime-2.1';
const VOICE = process.env.VOICE_VOICE || 'marin';
const AGENT_MODEL = process.env.AGENT_MODEL || 'claude-bridge/claude-opus-5-5';
const SESSION = process.env.AGENT_SESSION || 'voice-agent';
const AGENT_CWD = process.env.AGENT_CWD || join(HOME, 'projects/voice-agent');
const MAX_WORKERS = Number(process.env.MAX_WORKERS) || 4;
const DEBUG_LOG = join(HOME, '.local/state/voice-web/toolcalls.jsonl'); // every voice tool call, for review

const INSTRUCTIONS = `You are Allan's voice line to his Feather chats. You are a router, not an assistant: you do not think up answers, do research or give opinions. His Feather chats do the work. Your job is to carry his words to the right chat, bring back what it says, and tell him what is waiting on him.

Routing:
- He picks a chat on screen; a system note says which ("Picked chat: …"). Whatever he says goes to the picked chat with message_chat, in his own words: drop "um" and false starts, keep everything else, never rephrase, summarize or add to it. Questions too, even easy ones: the chat answers, not you.
- He names another chat ("tell the boat chat…", "ask the Alexa one…"): message_chat with that chat. "Switch to X", "talk to X", "go to X": pick_chat, then say its name in a few words.
- No chat is picked and he names none: ask "Which chat?" and nothing else. "New chat" or "start a chat about X": create_chat.
- "What's it doing", "what did it say", "is it done": read_chat (no chat = the picked one) and answer in a sentence from what it returns. Nothing is sent.
- "What's waiting on me", "what needs me", "catch me up": waiting_chats. Say how many, then each one in a few words: its name and what it needs from him, the ones that ask him something first. Skip the ones still working unless he asks. Then offer to switch to the top one.
- A system message "Feather #N done" brings a chat's reply. Say the gist in one or two sentences. If the chat asked him something, ask him that question. Never read paths, ids or code aloud.
- When he says to tell or ask a chat something, send it even if the chat is busy; it reads it after its current step. Only interrupt a chat when he says so.

Talking:
- Few words. Before a tool call say "On it." or nothing, never "let me check" or what you are about to do. Once per request; never "sent", task numbers or "Got it." after it. No filler, no recaps, no "let me know if".
- Every tool result has ok and say. When ok is false, it did not work as asked: tell him in a few words, and if error.choices is there, ask which one. Never claim something worked when ok is false.
- Only when he says "ask Feather" or wants a job done outside his chats: ask_feather. feather_status and stop_feather cover those jobs.
- The only things you answer yourself: which chat is picked, what you can do, and repeating what a chat said.`;

const TOOLS = [
  {
    type: 'function', name: 'ask_feather',
    description: 'Start a Feather task, or add to one. Returns a task number at once; the result arrives later as "Feather #N done". Call once per separate task; tasks run in parallel.',
    parameters: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'The full, self-contained request.' },
        task_id: { type: 'integer', description: 'Only to follow up on an existing task.' },
        steer: { type: 'boolean', description: 'With task_id on a running task: true redirects it now; default adds to it after the current step.' },
      },
      required: ['request'],
    },
  },
  {
    type: 'function', name: 'find_chat', description: 'Find his existing Feather chats by name or topic. Returns up to 5 with a chat handle, title, agent and whether it looks busy.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Words from the chat name or topic. Empty for the most recent chats.' } } },
  },
  {
    type: 'function', name: 'message_chat',
    description: 'Send a message into an existing Feather chat as him. Returns a task number at once; the chat\'s reply arrives as "Feather #N done".',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Omit for the picked chat. Otherwise the chat id from find_chat (best), or its name. If several chats match, nothing is sent and you get the choices.' },
        message: { type: 'string', description: 'What to send, as he would type it.' },
        interrupt: { type: 'boolean', description: 'Stop what the chat is doing first (also stops its autopilot). Only when he says so.' },
      },
      required: ['message'],
    },
  },
  {
    type: 'function', name: 'create_chat',
    description: 'Start a new Feather chat (a full agent with his tools). Returns at once with the chat; if a task is given it is sent as the first message and the chat\'s first reply arrives later as "Feather #N done".',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the new chat should do, as he would type it. Omit if he gave no task.' },
        title: { type: 'string', description: 'Short chat name, 2-6 words, only if he named it or the task makes it obvious.' },
        agent: { type: 'string', enum: ['claude', 'codex'], description: 'Only if he asks for a specific agent. Default is the fastest (a warm Claude chat).' },
      },
    },
  },
  {
    type: 'function', name: 'read_chat',
    description: 'Read an existing chat without touching it: its latest messages, whether it is busy, and its live screen when busy. Use it to answer his questions about a chat.',
    parameters: { type: 'object', properties: { chat: { type: 'string', description: 'Omit for the picked chat. Otherwise the chat id from find_chat, or its name.' } } },
  },
  {
    type: 'function', name: 'pick_chat',
    description: 'Make a chat the picked chat (shown on his screen), so later message_chat and read_chat calls go to it. Use for "switch to", "talk to", "pick" a chat.',
    parameters: { type: 'object', properties: { chat: { type: 'string', description: 'The chat id from find_chat, or his words for it.' } }, required: ['chat'] },
  },
  {
    type: 'function', name: 'waiting_chats',
    description: 'His chats from the last day that are waiting on him (the agent finished and the next move is his), with their last words and whether they ask him something; and the chats still working.',
    parameters: { type: 'object', properties: {} },
  },
  { type: 'function', name: 'feather_status', description: 'Which Feather tasks are running or queued, and recent results.', parameters: { type: 'object', properties: {} } },
  {
    type: 'function', name: 'stop_feather', description: 'Cancel a Feather task, or all of them.',
    parameters: { type: 'object', properties: { task_id: { type: 'integer', description: 'Omit to stop all.' } } },
  },
];

// ---------- Realtime key minting ----------

function codexAuth() {
  try {
    const t = JSON.parse(readFileSync(join(HOME, '.codex/auth.json'), 'utf8')).tokens;
    if (!t?.access_token) return null;
    const h = { Authorization: `Bearer ${t.access_token}` };
    if (t.account_id) h['ChatGPT-Account-Id'] = t.account_id;
    return h;
  } catch { return null; }
}

function apiKeyAuth() {
  let key = process.env.OPENAI_API_KEY;
  if (!key) {
    // The deployed release is read-only and public, so the key lives outside it.
    for (const f of [process.env.VOICE_ENV_FILE, join(HOME, '.config/feather/voice.env'), join(DIR, '.env'), join(HOME, '.env')].filter(Boolean)) {
      try {
        const line = readFileSync(f, 'utf8').split('\n').find(l => l.startsWith('OPENAI_API_KEY='));
        key = line?.slice('OPENAI_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
      } catch {}
      if (key) break;
    }
  }
  return key ? { Authorization: `Bearer ${key}` } : null;
}

function sessionConfig() {
  return {
    session: {
      type: 'realtime',
      model: MODEL,
      instructions: INSTRUCTIONS,
      audio: {
        input: {
          transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
          turn_detection: { type: 'semantic_vad', eagerness: 'auto' },
          noise_reduction: { type: 'near_field' },
        },
        output: { voice: VOICE },
      },
      tools: TOOLS,
      tool_choice: 'auto',
    },
  };
}

async function mint() {
  const order = process.env.VOICE_AUTH === 'apikey' ? [['apikey', apiKeyAuth()], ['codex', codexAuth()]]
    : [['codex', codexAuth()], ['apikey', apiKeyAuth()]];
  const errors = [];
  for (const [source, auth] of order) {
    if (!auth) continue;
    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(sessionConfig()),
    });
    const body = await res.text();
    if (res.ok) {
      const j = JSON.parse(body);
      return { value: j.value, expires_at: j.expires_at, model: MODEL, source };
    }
    errors.push(`${source}: ${res.status} ${body.slice(0, 200)}`);
  }
  throw new Error(errors.join(' | ') || 'no OpenAI credentials found');
}

// ---------- SSE ----------

const clients = new Set();
function broadcast(ev) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(data);
}

// ---------- tasks and workers ----------
// A task is one request thread. A worker is one warm pi process with its own session.
// A task stays bound to the worker that ran it, so follow-ups keep their context.

const tasks = new Map();   // id -> { id, request, worker, status, startedAt, seconds, tools, text, report }
const queue = [];          // task ids waiting for a free worker
const workers = [];
let nextTaskId = 1;

function taskView(t) {
  return { id: t.id, kind: t.kind || 'task', chat: t.chatId || null, request: t.request, status: t.status, seconds: t.status === 'running' ? Math.round((Date.now() - t.startedAt) / 1000) : t.seconds,
    tools: t.tools.slice(-6), text: t.text.slice(-1200), report: t.report.slice(-3000), error: t.error || null };
}
function recentTasks(n = 8) { return [...tasks.values()].slice(-n).map(taskView); }

function newWorker() {
  const w = { idx: workers.length, session: workers.length ? `${SESSION}-${workers.length + 1}` : SESSION,
    proc: null, buf: '', nextId: 1, pending: new Map(), ready: false, busy: false, task: null, lastText: '', lastError: null, sessionTask: null, restarts: 0 };
  workers.push(w);
  workerStart(w);
  return w;
}

function workerStart(w) {
  const env = { ...process.env, PATH: `${join(DIR, 'bin')}:${process.env.PATH}`, PI_FEATHER_EXTENSION: 'off' };
  const args = ['--mode', 'rpc', '--model', AGENT_MODEL, '--session-id', w.session, '--name', `Voice ${w.idx + 1}`,
    '--append-system-prompt', join(DIR, 'agent-voice-prompt.md')];
  const proc = spawn(process.env.PI_BIN || 'pi', args, { cwd: AGENT_CWD, env, stdio: ['pipe', 'pipe', 'pipe'] });
  w.proc = proc; w.buf = ''; w.ready = false;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    w.buf += chunk;
    let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i).replace(/\r$/, '');
      w.buf = w.buf.slice(i + 1);
      if (!line.trim()) continue;
      try { onRecord(w, JSON.parse(line)); } catch (e) { console.error(`[w${w.idx}] bad record`, e.message, line.slice(0, 200)); }
    }
  });
  proc.stderr.on('data', d => process.stderr.write(`[w${w.idx}] ${d}`));
  proc.stdin.on('error', e => console.error(`[w${w.idx}] stdin`, e.message)); // worker died; 'exit' restarts it
  proc.on('exit', (code, sig) => {
    console.error(`[w${w.idx}] exited code=${code} sig=${sig}`);
    for (const { reject } of w.pending.values()) reject(new Error('worker exited'));
    w.pending.clear();
    const t = w.busy && tasks.get(w.task);
    if (t) finishTask(t, { error: 'the worker crashed' });
    w.proc = null; w.busy = false; w.ready = false; w.sessionTask = null; w.task = null;
    setTimeout(() => workerStart(w), Math.min(30000, 1000 * 2 ** w.restarts++));
  });
  cmd(w, { type: 'get_state' }).then(s => {
    w.ready = true; w.restarts = 0;
    console.log(`[w${w.idx}] ready session=${s?.sessionId} model=${s?.model?.provider}/${s?.model?.id}`);
    broadcast({ type: 'workers', ...poolView() });
    dispatch();
  }).catch(e => console.error(`[w${w.idx}] get_state failed`, e.message));
}

function cmd(w, c, timeoutMs = 30000) {
  if (!w.proc) return Promise.reject(new Error('worker is not running'));
  const id = `v${w.nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { w.pending.delete(id); reject(new Error(`${c.type} timed out`)); }, timeoutMs);
    w.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    w.proc.stdin.write(JSON.stringify({ ...c, id }) + '\n');
  });
}

function textFromMessage(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function toolLabel(name, a = {}) {
  const s = a?.command || a?.path || a?.file_path || a?.url || a?.query || a?.pattern || '';
  return `${name}${s ? ': ' + String(s).replace(/\s+/g, ' ').slice(0, 140) : ''}`;
}

function onRecord(w, r) {
  if (r.type === 'response') {
    const p = r.id && w.pending.get(r.id);
    if (p) { w.pending.delete(r.id); r.success ? p.resolve(r.data) : p.reject(new Error(r.error || 'agent error')); }
    return;
  }
  const t = w.task != null ? tasks.get(w.task) : null;
  switch (r.type) {
    case 'message_start':
      if (t && r.message?.role === 'assistant') { t.text = ''; broadcast({ type: 'task_text_reset', id: t.id }); }
      break;
    case 'message_update': {
      const e = r.assistantMessageEvent;
      if (t && e?.type === 'text_delta') { t.text += e.delta; broadcast({ type: 'task_delta', id: t.id, delta: e.delta }); }
      break;
    }
    case 'message_end':
      if (r.message?.role === 'assistant') {
        // A model error (refusal, API failure) arrives as an assistant message with stopReason "error".
        // Keep it apart from real text so it is never reported as a result.
        if (r.message.stopReason === 'error') {
          w.lastError = r.message.errorMessage || textFromMessage(r.message) || 'model error';
          if (t) broadcast({ type: 'task_note', id: t.id, text: w.lastError.split('\n')[0].slice(0, 200) });
        } else {
          const txt = textFromMessage(r.message);
          w.lastError = null;
          if (txt) w.lastText = txt;
        }
      }
      break;
    case 'tool_execution_start':
      if (t) { const label = toolLabel(r.toolName, r.args); t.tools.push(label); broadcast({ type: 'task_tool', id: t.id, label }); }
      break;
    case 'auto_retry_start':
      if (t) broadcast({ type: 'task_note', id: t.id, text: `retrying (${r.errorMessage || 'error'})` });
      break;
    case 'auto_retry_end':
      if (r.success === false) w.lastError = r.finalError || w.lastError || 'model error after retries';
      else w.lastError = null;
      break;
    case 'agent_settled':
      w.busy = false;
      if (t && w.lastError && !r.aborted) finishTask(t, { error: w.lastError, code: errorCode(w.lastError) });
      else if (t) finishTask(t, { aborted: !!r.aborted, text: w.lastText });
      w.task = null;
      dispatch();
      break;
    case 'extension_ui_request':
      if (['select', 'confirm', 'input', 'editor'].includes(r.method)) {
        w.proc?.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: r.id, cancelled: true }) + '\n');
        if (t) broadcast({ type: 'task_note', id: t.id, text: `dialog "${r.title || r.method}" auto-cancelled` });
      }
      break;
  }
}

// refused: the model's safety filter blocked the turn. backend: any other model/API failure.
function errorCode(msg) {
  const m = String(msg || '');
  return /safeguard|flagged|usage polic|refus(e|ed|al)\b/i.test(m) && !/ECONNREFUSED|connection refused/i.test(m) ? 'refused' : 'backend';
}

function finishTask(t, { aborted, error, code, text }) {
  t.status = error ? 'error' : aborted ? 'stopped' : 'done';
  t.seconds = Math.round((Date.now() - t.startedAt) / 1000);
  t.error = error ? { code: code || 'backend', message: String(error).split('\n')[0].slice(0, 300) } : null;
  t.report = error ? `Failed (${t.error.code}): ${t.error.message}` : (text || '');
  // A short record of the task, so a follow-up on any worker (fresh session) gets the context back.
  t.history = `${t.history || ''}\nRequest: ${t.lastMessage || t.request}\nResult: ${t.report.slice(0, 1500)}`.slice(-4000);
  broadcast({ type: 'task_done', ...taskView(t) });
}

function poolView() {
  return { workers: workers.length, ready: workers.filter(w => w.ready).length, busy: workers.filter(w => w.busy).length, max: MAX_WORKERS, queued: queue.length };
}

// Each task gets its own pi session. One bad context (say, a refusal) then cannot spill into the
// next task. A follow-up that lands on a worker whose session holds another task starts a fresh
// session too, with a short recap of the task so far.
// While the session is being set up (phase "setup") no model run exists yet, so a stop only sets
// t.cancelled and a follow-up waits in t.setupExtra; both are checked before the prompt goes in.
async function run(w, t, message) {
  w.busy = true; w.task = t.id; t.worker = w.idx;
  t.status = 'running'; t.startedAt = Date.now(); t.tools = []; t.text = ''; t.error = null;
  t.phase = 'setup'; t.cancelled = false; t.setupExtra = '';
  w.lastText = ''; w.lastError = null;
  broadcast({ type: 'task_start', ...taskView(t) });
  const release = () => { w.busy = false; w.task = null; t.phase = null; };
  const stopped = () => { if (!t.cancelled) return false; release(); finishTask(t, { aborted: true }); dispatch(); return true; };
  try {
    if (w.sessionTask !== t.id) {
      // Reopen this task's own session if it has one; else start a fresh one.
      let r = t.sessionFile ? await cmd(w, { type: 'switch_session', sessionPath: t.sessionFile }).catch(() => null) : null;
      if (stopped()) return;
      const reopened = r && r.cancelled === false;
      if (!reopened) {
        w.sessionTask = null;
        r = await cmd(w, { type: 'new_session' });
        if (r?.cancelled !== false) throw new Error('could not start a fresh worker session');
        await cmd(w, { type: 'set_session_name', name: `Voice #${t.id}: ${t.request.slice(0, 60)}` }).catch(() => {});
        t.sessionFile = (await cmd(w, { type: 'get_state' }).catch(() => null))?.sessionFile || null;
        if (t.history) message = `[voice] Earlier in task #${t.id}:${t.history}\n\n${message}`;
      }
      w.sessionTask = t.id;
      if (stopped()) return;
    }
    if (t.setupExtra) message += t.setupExtra;
    t.phase = 'run';
    const r = await cmd(w, { type: 'prompt', message, streamingBehavior: 'followUp' });
    // "handled" means an extension consumed it: no run starts, so no agent_settled will come.
    if (r?.disposition === 'handled') { release(); finishTask(t, { text: '(handled without a run)' }); dispatch(); }
  } catch (e) {
    release(); finishTask(t, { error: e.message, code: 'backend' });
    // A timed-out RPC may still be running in pi: restart the worker rather than hand it new work.
    if (/timed out/.test(e.message) && w.proc) { w.ready = false; w.proc.kill(); }
    dispatch();
  }
}

function dispatch() {
  for (const id of [...queue]) {
    const t = tasks.get(id);
    const drop = () => queue.splice(queue.indexOf(id), 1);
    if (!t || t.status !== 'queued') { drop(); continue; }
    // A follow-up prefers the worker that still has its session; any idle worker can take it with a recap.
    const bound = t.worker != null ? workers[t.worker] : null;
    const idle = x => x.ready && !x.busy;
    const w = bound && idle(bound) && bound.sessionTask === t.id ? bound
      : workers.find(x => idle(x) && x.sessionTask == null) || workers.find(idle);
    if (!w) continue;
    drop();
    run(w, t, t.pendingMessage);
  }
  // Start enough extra workers for the new tasks still waiting.
  const waiting = queue.length;
  for (let starting = workers.filter(x => !x.ready).length; starting < waiting && workers.length < MAX_WORKERS; starting++) newWorker();
  broadcast({ type: 'workers', ...poolView() });
}

async function ask(request, taskId, steer, callId) {
  const t0 = taskId != null ? tasks.get(Number(taskId)) : null;
  if (taskId != null && !t0) throw fail('not_found', `There is no task ${taskId} any more. Nothing was sent.`);
  if (t0?.kind === 'chat') {
    const prior = await lastMessages(t0.chatId, 1);
    await sendTo(t0.chatId, request, callId);
    Object.assign(t0, { request: `${t0.request} → ${request}`, status: 'running', startedAt: Date.now(), tools: [], text: '', report: '', error: null, afterUuid: prior.at(-1)?.uuid || null });
    broadcast({ type: 'task_start', ...taskView(t0) });
    watchChat(t0);
    return { task_id: t0.id, chat: chatRef(t0.chatId, t0.chatTitle), status: 'sent' };
  }
  if (t0) {
    const w = workers[t0.worker];
    if (t0.status === 'running' && t0.phase === 'setup') {
      t0.setupExtra += `\n\n[voice] ${request}`;
      return { task_id: t0.id, status: 'added to the running task' };
    }
    if (t0.status === 'running' && w?.busy && w.task === t0.id) {
      await cmd(w, { type: steer ? 'steer' : 'follow_up', message: `[voice] ${request}` });
      broadcast({ type: 'task_note', id: t0.id, text: (steer ? 'redirected: ' : 'added: ') + request });
      return { task_id: t0.id, status: steer ? 'redirected' : 'added to the running task' };
    }
    if (t0.status === 'queued') { t0.pendingMessage += `\n\n[voice] ${request}`; return { task_id: t0.id, status: 'added to the queued task' }; }
    // Finished: reopen it on the same worker so it keeps its context.
    t0.request = `${t0.request} → ${request}`; t0.status = 'queued'; t0.pendingMessage = `[voice] ${request}`; t0.lastMessage = request;
    queue.push(t0.id); dispatch();
    return { task_id: t0.id, status: t0.status === 'running' ? 'started' : 'queued' };
  }
  const t = { id: nextTaskId++, request, lastMessage: request, worker: null, status: 'queued', startedAt: Date.now(), seconds: 0, tools: [], text: '', report: '',
    pendingMessage: `[voice] Task #${nextTaskId - 1}: ${request}` };
  tasks.set(t.id, t);
  if (tasks.size > 50) tasks.delete(tasks.keys().next().value);
  queue.push(t.id);
  broadcast({ type: 'task_queued', ...taskView(t) });
  dispatch();
  return { task_id: t.id, status: t.status === 'running' ? 'started' : 'queued, starting shortly' };
}

async function stopTask(taskId) {
  const list = taskId != null ? [tasks.get(Number(taskId))].filter(Boolean) : [...tasks.values()];
  let n = 0, watchOnly = 0;
  for (const t of list) {
    // A chat task only stops our watching; the chat itself keeps working (interrupting it is message_chat's job).
    if (t.kind === 'chat' && t.status === 'running') { finishTask(t, { aborted: true, text: '(stopped watching; the chat keeps working)' }); n++; watchOnly++; continue; }
    if (t.status === 'queued') { t.status = 'stopped'; t.report = ''; broadcast({ type: 'task_done', ...taskView(t) }); n++; }
    else if (t.status === 'running') {
      const w = workers[t.worker];
      if (w?.task === t.id) {
        t.cancelled = true; n++; // run() checks this if the session is still being set up
        if (t.phase === 'run') { await cmd(w, { type: 'clear_queue' }).catch(() => {}); await cmd(w, { type: 'abort' }, 60000).catch(() => {}); }
      }
    }
  }
  if (!n) return errResult(fail(taskId != null ? 'not_found' : 'bad_args', taskId != null ? `No running task ${taskId}.` : 'Nothing is running.'));
  return okResult(watchOnly === n ? 'Stopped watching. The chat itself keeps working.' : 'Stopped.', { stopped: n, chat_watch_only: watchOnly, status: 'stopped' });
}

// ---------- existing Feather chats ----------
// The voice can message any Feather chat (any harness) and hear its reply. Feather has no
// harness-neutral "turn finished" event, so a reply counts as done when the chat's latest
// message is assistant text with no tool call and nothing new arrives for CHAT_QUIET_MS.

const FEATHER = process.env.FEATHER_URL || 'http://127.0.0.1:3300';
const CHAT_QUIET_MS = 8000;
const CHAT_MAX_MS = 20 * 60 * 1000;

// A tool failure with a code the voice model can act on.
function fail(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

async function feather(pathname, body, { timeoutMs = 20000, messageId } = {}) {
  let res;
  try {
    res = await fetch(FEATHER + pathname, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Feather-Message-ID': messageId || crypto.randomUUID() }, body: JSON.stringify(body),
      }),
    });
  } catch (e) {
    throw e.name === 'TimeoutError' ? fail('timeout', `Feather did not answer in ${timeoutMs / 1000} s`) : fail('backend', `Feather is not reachable: ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error || msg; } catch {}
    throw fail(res.status === 409 && /starting/i.test(msg) ? 'starting' : res.status === 404 ? 'not_found' : 'backend', `Feather ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

function blocks(m) { return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content || []); }
function msgText(m) { return blocks(m).filter(b => b.type === 'text').map(b => b.text).join('\n').trim(); }
function isToolResult(m) { const b = blocks(m); return m.role === 'user' && b.length > 0 && b.every(x => x.type === 'tool_result'); }

async function lastMessages(id, n = 12) {
  return (await feather(`/api/sessions/${id}/messages?limit=${n}`)).messages || [];
}

// Busy: the chat's last turn has not ended (a user message or a tool call is the latest).
function looksBusy(msgs, updatedAt) {
  const last = msgs.filter(m => m.role === 'user' || m.role === 'assistant').at(-1);
  if (!last || Date.now() - Date.parse(updatedAt || last.timestamp || 0) > 30 * 60 * 1000) return false;
  return last.role === 'user' || blocks(last).some(b => b.type === 'tool_use');
}

// Chats a person would pick: not the voice workers' own transcripts, not sidecar helpers.
function pickable(s) {
  return !s.chatStandby && !/^\[voice\]/.test(s.title || '') && !/(^|-)voice-agent$/.test(s.projectId || '')
    && !/^(You are a Feather \*\*sidecar|\[feather-sidecar )/.test(s.title || '');
}
const untitled = s => !s.title || s.title === s.id.slice(0, 8);
const STOP = new Set('a an and are about any chat chats feather find for from in is it me my of on one or our search that the this to was we were what where which with you your'.split(' '));
const sessions = async (limit, q) => ((await feather(`/api/sessions?limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ''}`)).sessions || []).filter(pickable);

const queryWords = q => [...new Set(String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1 && !STOP.has(w)))];
// A word starts somewhere in the title ("boat" hits "#boat" and "boats", not "sailboat").
const titleHas = (title, w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu').test(title || '');

// Feather's search needs every word to match somewhere in a chat. Spoken queries rarely do
// ("disaster kit Amazon" for a chat about emergency supplies), so when the whole query finds
// little, each word is also searched on its own. Chats are ranked by words in the title first
// (a long chat that mentions everything should not beat the chat named for it), then by how
// many words hit the content, then by recency.
async function searchChats(query = '', limit = 20) {
  const q = String(query).trim();
  if (!q) return (await sessions(limit + 15)).filter(s => !untitled(s)).slice(0, limit);
  if (/^[0-9a-f]{8}(-[0-9a-f-]*)?$/i.test(q)) return (await sessions(400)).filter(s => s.id.startsWith(q.toLowerCase())).slice(0, limit);
  const words = queryWords(q);
  if (!words.length) return [];
  const score = new Map(), seen = new Map();
  const hit = (s, n) => { score.set(s.id, (score.get(s.id) || 0) + n); if (!seen.has(s.id)) seen.set(s.id, s); };
  (await sessions(limit + 10, words.join(' '))).forEach(s => hit(s, words.length));
  if (seen.size < 3 && words.length > 1) {
    const per = await Promise.all(words.map(w => sessions(15, w).catch(() => [])));
    per.forEach(list => list.forEach(s => hit(s, 1)));
  }
  const at = s => Date.parse(s.updatedAt || 0) || 0;
  const phrase = words.join(' ');
  for (const s of seen.values()) {
    const t = (s.title || '').toLowerCase();
    hit(s, words.filter(w => titleHas(t, w)).length * 10 + (t.includes(phrase) ? 10 : 0));
  }
  return [...seen.values()].sort((a, b) => score.get(b.id) - score.get(a.id) || at(b) - at(a)).slice(0, limit);
}

// The picker's list: cheap, no per-chat transcript reads.
function chatRow(s) {
  return { id: s.id, chat: s.id.slice(0, 8), title: untitled(s) ? '(untitled)' : s.title, agent: s.agent, live: !!s.isActive,
    minutes_since_activity: s.updatedAt ? Math.round((Date.now() - Date.parse(s.updatedAt)) / 60000) : null };
}

async function findChats(query = '') {
  const list = await searchChats(query, 5);
  return Promise.all(list.map(async s => {
    let busy = false;
    try { busy = looksBusy(await lastMessages(s.id, 4), s.updatedAt); } catch {}
    return { chat: s.id.slice(0, 8), id: s.id, title: s.title || '(untitled)', agent: s.agent, busy,
      minutes_since_activity: s.updatedAt ? Math.round((Date.now() - Date.parse(s.updatedAt)) / 60000) : null };
  }));
}

// Pick one chat, or refuse: a message must never land in the wrong chat.
// Accepts a full id, a unique id prefix (8+ hex), or a title: an exact match, or the only chat whose title contains the words.
async function resolveChat(chat) {
  const q = String(chat || '').trim();
  const norm = x => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
    const d = await feather(`/api/sessions?id=${q.toLowerCase()}`);
    const s = (d.sessions || []).find(x => x.id === q.toLowerCase());
    if (!s) throw fail('not_found', `No Feather chat has the id ${q}. Nothing was done.`);
    let busy = false;
    try { busy = looksBusy(await lastMessages(s.id, 4), s.updatedAt); } catch {}
    return { chat: s.id.slice(0, 8), id: s.id, title: s.title || '(untitled)', agent: s.agent, busy,
      minutes_since_activity: s.updatedAt ? Math.round((Date.now() - Date.parse(s.updatedAt)) / 60000) : null };
  }
  const found = await findChats(q);
  if (/^[0-9a-f]{8}(-[0-9a-f-]*)?$/i.test(q) && found.length === 1) return found[0];
  const exact = found.filter(c => norm(c.title) === norm(q));
  if (exact.length === 1) return exact[0];
  const named = found.filter(c => norm(c.title).includes(norm(q).replace(/^#/, '')));
  if (named.length === 1 && !/^[0-9a-f]{8,}$/i.test(q)) return named[0];
  // "the Alexa chat": the one chat whose title has every word he said.
  const words = queryWords(q);
  const titled = found.filter(c => words.length && words.every(w => titleHas(c.title, w)));
  if (titled.length === 1) return titled[0];
  if (!found.length) throw fail('not_found', `No Feather chat matches "${q}". Nothing was sent.`);
  throw fail('ambiguous_chat', `"${q}" matches more than one chat, so nothing was done. Ask him which one, then pass its chat id.`,
    { choices: found.map(c => ({ chat: c.chat, title: c.title, busy: c.busy })) });
}

// Send as Allan. The message id comes from the voice call id, so a retried call is delivered once.
// On failure, say what did happen: an interrupt may have gone through, a timed-out send may still arrive.
async function sendTo(id, text, callId, interrupted) {
  try {
    await feather(`/api/sessions/${id}/send`, { text }, { timeoutMs: 30_000, messageId: callId ? opId(callId, 'send') : undefined });
  } catch (e) {
    const what = e.code === 'timeout' ? 'the send timed out, so it may still arrive. Check with read_chat before sending again.' : `the send failed (${e.message}).`;
    throw fail(e.code || 'backend', interrupted ? `I interrupted the chat, but ${what}` : what[0].toUpperCase() + what.slice(1));
  }
}

async function messageChat(chat, message, interrupt, callId) {
  const c = await resolveChat(chat);
  const ref = chatRef(c.id, c.title);
  if (interrupt) await feather(`/api/sessions/${c.id}/interrupt`, {});
  // A chat that is still replying to an earlier message keeps one task; the new message joins it.
  const open = [...tasks.values()].find(x => x.kind === 'chat' && x.chatId === c.id && x.status === 'running');
  if (open) {
    await sendTo(c.id, message, callId, interrupt);
    open.request += ` → ${message}`;
    broadcast({ type: 'task_start', ...taskView(open) });
    return okResult(interrupt ? 'Interrupted it and sent.' : 'Sent.', { task_id: open.id, chat: ref, status: 'sent' });
  }
  const prior = await lastMessages(c.id, 1);
  const sentAt = Date.now();
  await sendTo(c.id, message, callId, interrupt);
  const t = newChatTask(c.id, c.title, `→ ${c.title}: ${message}`, { startedAt: sentAt, afterUuid: prior.at(-1)?.uuid || null });
  watchChat(t);
  return okResult(c.busy && !interrupt ? 'Sent. It is busy, so it will read it after its current step.' : 'Sent.', { task_id: t.id, chat: ref, status: 'sent' });
}

function newChatTask(chatId, chatTitle, request, extra = {}) {
  const t = { id: nextTaskId++, kind: 'chat', chatId, chatTitle, request, worker: null, status: 'running', startedAt: Date.now(),
    seconds: 0, tools: [], text: '', report: '', error: null, afterUuid: null, ...extra };
  tasks.set(t.id, t);
  if (tasks.size > 50) tasks.delete(tasks.keys().next().value);
  broadcast({ type: 'task_start', ...taskView(t) });
  return t;
}

// Poll the chat until its reply settles, streaming its tool calls and text to the task card.
async function watchChat(t) {
  const run = t.run = (t.run || 0) + 1;
  const began = Date.now();
  let seen = new Set(), lastChange = Date.now();
  while (t.status === 'running' && t.run === run) {
    await new Promise(r => setTimeout(r, 2000));
    if (t.status !== 'running' || t.run !== run) return;
    let msgs;
    try { msgs = await lastMessages(t.chatId, 30); } catch {
      if (Date.now() - t.startedAt > CHAT_MAX_MS) return finishTask(t, { error: 'Feather stopped answering while I waited for the reply', code: 'timeout' });
      continue;
    }
    // A new chat: count only what comes after our first message, never its setup text.
    if (t.matchText) {
      const mine = msgs.find(m => m.role === 'user' && msgText(m).includes(t.matchText));
      if (mine) { t.afterUuid = mine.uuid; t.matchText = null; }
      else if (Date.now() - began < 60_000) continue;
      else t.matchText = null; // not found (another message shape): fall back to timestamps
    }
    const start = msgs.findIndex(m => m.uuid === t.afterUuid);
    const fresh = (start >= 0 ? msgs.slice(start + 1) : msgs.filter(m => Date.parse(m.timestamp) >= t.startedAt - 2000))
      .filter(m => m.role === 'assistant' || m.role === 'user');
    for (const m of fresh) {
      if (seen.has(m.uuid)) continue;
      seen.add(m.uuid); lastChange = Date.now();
      for (const b of blocks(m)) {
        if (b.type === 'tool_use') { const label = toolLabel(b.name, b.input); t.tools.push(label); broadcast({ type: 'task_tool', id: t.id, label }); }
      }
      const txt = m.role === 'assistant' ? msgText(m) : '';
      if (txt) { t.text = txt; broadcast({ type: 'task_text_reset', id: t.id }); broadcast({ type: 'task_delta', id: t.id, delta: txt.slice(-1200) }); }
    }
    const last = fresh.filter(m => !isToolResult(m)).at(-1);
    const settled = last?.role === 'assistant' && msgText(last) && !blocks(last).some(b => b.type === 'tool_use');
    if (settled && Date.now() - lastChange >= CHAT_QUIET_MS) {
      const replies = fresh.filter(m => m.role === 'assistant').map(msgText).filter(Boolean);
      return finishTask(t, { text: replies.slice(-2).join('\n\n') });
    }
    if (Date.now() - t.startedAt > CHAT_MAX_MS) return finishTask(t, { text: `(${t.chatTitle} is still working after 20 minutes; its latest words: ${t.text.slice(-400) || 'none'})` });
  }
}

// ---------- new chats ----------
// create_chat calls Feather directly: no LLM in the path. With no options, POST /api/chats hands
// out a warm standby chat at once; asking for another agent means a cold start (about 10-60 s).
// The task goes in as a normal first message, the same as Allan typing it: the chat does not start
// ongoing work on its own. The voice call id keys the whole operation, so a retried call never
// makes a second chat or sends the task twice.

const createOps = new Map();   // call id -> { fp, at, promise, unknown?, task?, resend? }
const opId = (key, suffix) => `voice-${String(key).replace(/[^a-zA-Z0-9_-]/g, '').slice(-80)}-${suffix}`;

function createChat(args, callId) {
  const task = String(args.task || '').trim().slice(0, 20000);
  const title = String(args.title || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  const agent = args.agent === 'codex' ? 'codex' : null;
  const fp = JSON.stringify([task, title, agent]);
  for (const o of createOps.values()) if (Date.now() - o.at > 3600_000) createOps.delete(o.key);
  const op = callId && createOps.get(callId);
  if (op) {
    if (op.fp !== fp) return errResult(fail('bad_args', 'That call id was already used for a different new chat.'));
    // The first message failed to send: send it again, with the same message id, so it lands once.
    if (op.task?.sendFailed) return op.resend();
    return op.promise;
  }
  // Without a call id to go by, the same task twice within 15 s is the voice model repeating itself.
  // So is any repeat of a create whose outcome is unknown (it timed out; the chat may exist).
  for (const o of createOps.values())
    if (o.fp === fp && (o.unknown ? Date.now() - o.at < 60_000 : task && Date.now() - o.at < 15_000)) return o.promise;
  const key = callId || crypto.randomUUID().replace(/-/g, '');
  const n = { key, fp, at: Date.now() };
  n.promise = doCreateChat({ task, title, agent }, key, n).then(r => {
    if (!r.ok && !r.chat) {
      if (r.error.code === 'timeout') n.unknown = true; // a retry with the same call id reuses the same Feather requestId
      else createOps.delete(key);
    }
    return r;
  });
  createOps.set(key, n);
  return n.promise;
}

async function doCreateChat({ task, title, agent }, key, op) {
  let c;
  try {
    c = await feather('/api/chats', { requestId: opId(key, 'create'), ...(agent ? { agent } : {}) }, { timeoutMs: 30_000 });
  } catch (e) {
    if (e.code === 'timeout') e.message = 'Feather did not answer in time, so the chat may or may not exist. Check with find_chat before trying again.';
    return errResult(e);
  }
  if (c.status === 'failed') return errResult(fail('backend', `Feather could not start the chat: ${c.error || 'startup failed'}`));
  const starting = c.status === 'starting';
  let renamed = !title || starting;
  if (title && !starting) renamed = await feather(`/api/sessions/${c.id}/rename`, { title }).then(() => true, () => false);
  const chat = chatRef(c.id, title && renamed ? title : 'New chat');
  const note = renamed ? '' : ` I could not name it "${title}".`;
  if (!task) {
    if (!starting) return okResult(`Started ${title && renamed ? title : 'a new chat'}.${note} What should it work on?`, { chat, status: 'ready' });
    // A cold start: track it as a task, so he hears when it is ready, or that it failed.
    const t = newChatTask(c.id, chat.title, `new chat${title ? ` "${title}"` : ''}: starting`);
    finishStartup(t, c.id, title);
    return okResult('Starting a new chat; I will tell you when it is ready.', { chat, task_id: t.id, status: 'starting' });
  }
  const t = newChatTask(c.id, chat.title, `new chat${title ? ` "${title}"` : ''}: ${task}`, { matchText: task.split('\n')[0].slice(0, 50) });
  op.task = t;
  op.resend = () => {
    Object.assign(t, { sendFailed: false, status: 'running', error: null, report: '', startedAt: Date.now() });
    broadcast({ type: 'task_start', ...taskView(t) });
    sendFirstMessage(t, c.id, task, title, key);
    return okResult('Sending it the task again.', { chat, task_id: t.id, status: 'sending' });
  };
  sendFirstMessage(t, c.id, task, title, key);
  return okResult(`Started ${title && renamed ? title : 'a new chat'}; sending it the task.${note}`, { chat, task_id: t.id, status: 'sending' });
}

// The first message runs in the background: Feather's /send waits (up to 180 s) for a cold chat to finish starting.
// A failure ends the task with an error; the same create_chat call id then retries the send.
async function sendFirstMessage(t, id, task, title, key) {
  const text = title ? `${task}\n\n(Allan named this chat "${title}". Keep that title.)` : task;
  try {
    await feather(`/api/sessions/${id}/send`, { text }, { timeoutMs: 200_000, messageId: opId(key, 'send') });
  } catch (e) {
    t.sendFailed = true;
    return finishTask(t, { error: `${e.code === 'timeout' ? 'The task send timed out and may still arrive' : `The task did not send: ${e.message}`}. The chat exists (${id.slice(0, 8)}).`, code: e.code || 'backend' });
  }
  if (title) await feather(`/api/sessions/${id}/rename`, { title }).catch(() => {});
  watchChat(t);
}

async function finishStartup(t, id, title) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && t.status === 'running') {
    await new Promise(r => setTimeout(r, 2000));
    let s;
    try { s = await feather(`/api/chats/${id}/status`); } catch (e) {
      if (e.code === 'not_found') return finishTask(t, { error: 'The new chat is gone; it was deleted while starting.', code: 'not_found' });
      continue;
    }
    if (s.status === 'failed') return finishTask(t, { error: `The new chat failed to start: ${s.error || 'startup failed'}`, code: 'backend' });
    if (s.status === 'ready') {
      const named = !title || await feather(`/api/sessions/${id}/rename`, { title }).then(() => true, () => false);
      return finishTask(t, { text: `${title || 'The new chat'} is ready.${named ? '' : ` I could not name it "${title}".`}` });
    }
  }
  if (t.status === 'running') finishTask(t, { error: 'The new chat did not finish starting in 3 minutes.', code: 'timeout' });
}

// ---------- reading a chat ----------

function tmuxScreen(id, lines = 25) {
  try {
    return execFileSync('tmux', ['capture-pane', '-p', '-J', '-t', `feather-${id.slice(0, 8)}`, '-S', `-${lines}`], { encoding: 'utf8', timeout: 3000 })
      .replace(/\n{3,}/g, '\n\n').trim().slice(-1500);
  } catch { return null; }
}

// "What's waiting on me": chats from the last day whose turn has ended with the agent's words,
// so the next move is his. Feather keeps no read marks, so a chat he already read still counts
// until he answers it. Chats still working are listed apart.
async function waitingChats(hours = 24) {
  const since = Date.now() - hours * 3600_000;
  const recent = (await sessions(40)).filter(s => !untitled(s) && s.title !== 'New chat' && Date.parse(s.updatedAt || 0) > since).slice(0, 20);
  const rows = await Promise.all(recent.map(async s => {
    const msgs = await lastMessages(s.id, 6).catch(() => []);
    const minutes = Math.round((Date.now() - Date.parse(s.updatedAt)) / 60000);
    if (looksBusy(msgs, s.updatedAt)) return { kind: 'working', chat: s.id.slice(0, 8), title: s.title, minutes_since_activity: minutes };
    const last = msgs.filter(m => (m.role === 'user' || m.role === 'assistant') && !isToolResult(m)).at(-1);
    if (last?.role !== 'assistant') return null;
    const text = msgText(last);
    if (!text) return null;
    const tail = text.slice(-400);
    return { kind: 'waiting', chat: s.id.slice(0, 8), title: s.title, minutes_since_activity: minutes,
      asks_him: /\?\s*$/.test(text) || s.workflow?.phase === 'blocked', last_words: tail.length < text.length ? '…' + tail : tail };
  }));
  const waiting = rows.filter(r => r?.kind === 'waiting').slice(0, 8), working = rows.filter(r => r?.kind === 'working');
  const say = waiting.length ? `${waiting.length} chat${waiting.length > 1 ? 's' : ''} waiting on him${working.length ? `, ${working.length} still working` : ''}.`
    : working.length ? `Nothing waiting on him; ${working.length} still working.` : 'Nothing waiting on him.';
  return okResult(say, { waiting: waiting.map(({ kind, ...r }) => r), working: working.map(({ kind, ...r }) => r) });
}

async function readChat(chat) {
  const c = await resolveChat(chat);
  const msgs = await lastMessages(c.id, 16);
  const said = msgs.filter(m => (m.role === 'user' || m.role === 'assistant') && !isToolResult(m))
    .map(m => { const t = msgText(m); return t ? `${m.role === 'user' ? 'Allan' : 'Chat'}: ${t.slice(0, 700)}` : null; })
    .filter(Boolean).slice(-6).join('\n\n').slice(-3500);
  return okResult(`${c.title} is ${c.busy ? 'busy' : 'idle'}.`, {
    chat: chatRef(c.id, c.title), busy: c.busy, minutes_since_activity: c.minutes_since_activity,
    messages: said || '(no messages yet)', ...(c.busy ? { screen: tmuxScreen(c.id) } : {}),
  });
}

// ---------- tool router ----------
// Every voice tool returns { ok: true, say, ...data } or { ok: false, say, error: { code, message, retryable, choices? }, chat? }.
// Codes: bad_args, not_found, ambiguous_chat, starting, timeout, refused, backend.

const RETRYABLE = new Set(['timeout', 'starting', 'backend']);
function okResult(say, data = {}) { return { ok: true, say, ...data }; }
function errResult(e) {
  const code = e.code || 'backend';
  return { ok: false, say: e.message, error: { code, message: e.message, retryable: RETRYABLE.has(code), ...(e.choices ? { choices: e.choices } : {}) },
    ...(e.chat ? { chat: e.chat } : {}) };
}
function chatRef(id, title) { return { id, title: title || '(untitled)', url: `/#${id}` }; }
function need(args, ...keys) {
  for (const k of keys) if (typeof args[k] !== 'string' || !args[k].trim()) throw fail('bad_args', `${k} is required`);
}

function statusView() {
  return recentTasks().map(t => ({ id: t.id, kind: t.kind, request: t.request.slice(0, 200), status: t.status, seconds: t.seconds,
    ...(t.status === 'running' ? { recent_tools: t.tools, partial: t.text.slice(-400) } : { result: t.report.slice(-600) }),
    ...(t.error ? { error: t.error } : {}) }));
}

const HANDLERS = {
  async ask_feather(a, callId) {
    need(a, 'request');
    const r = await ask(a.request.slice(0, 20000), a.task_id, !!a.steer, callId);
    return okResult('On it.', r);
  },
  create_chat: (a, callId) => createChat(a, callId),
  async message_chat(a, callId, picked) { need(a, 'message'); return messageChat(chatArg(a, picked), a.message.slice(0, 20000), !!a.interrupt, callId); },
  async read_chat(a, callId, picked) { return readChat(chatArg(a, picked)); },
  async waiting_chats() { return waitingChats(); },
  async pick_chat(a) {
    need(a, 'chat');
    const c = await resolveChat(a.chat);
    return okResult(`Picked ${c.title}.`, { picked: { id: c.id, title: c.title }, busy: c.busy });
  },
  async find_chat(a) {
    const chats = await findChats(a.query || '');
    return okResult(chats.length ? `${chats.length} chat${chats.length > 1 ? 's' : ''} found.` : 'No chats match.',
      { chats: chats.map(c => ({ ...c, url: `/#${c.id}` })) });
  },
  async feather_status() {
    const list = statusView();
    const running = list.filter(t => t.status === 'running' || t.status === 'queued').length;
    return okResult(running ? `${running} task${running > 1 ? 's' : ''} running.` : 'Nothing running.', { tasks: list });
  },
  async stop_feather(a) { return stopTask(a.task_id); },
};

// A retried call id gets the first success back instead of acting twice. A failure is not kept:
// the retry runs again, and its sends reuse the same message id, so Feather delivers them once.
const callMemo = new Map();   // "tool:call id" -> { at, promise }
const MEMO_TOOLS = new Set(['ask_feather', 'message_chat']);

// No chat named: the one he picked on the page.
function chatArg(a, picked) {
  const c = typeof a.chat === 'string' ? a.chat.trim() : '';
  if (c && !/^(it|this|that|the chat|this chat|that chat|picked|current|the picked chat)$/i.test(c)) return c;
  if (picked) return picked;
  throw fail('bad_args', 'No chat is picked and none was named. Ask him which chat.');
}

async function runTool(name, args, callId, picked) {
  const h = HANDLERS[name];
  if (!h) return errResult(fail('bad_args', `unknown tool ${name}`));
  const memoKey = callId && MEMO_TOOLS.has(name) ? `${name}:${callId}` : null;
  if (memoKey && callMemo.has(memoKey)) return callMemo.get(memoKey).promise;
  const promise = (async () => {
    try { return await h(args && typeof args === 'object' ? args : {}, callId, picked); }
    catch (e) { return errResult(e); }
  })();
  if (memoKey) {
    callMemo.set(memoKey, { at: Date.now(), promise });
    for (const [k, m] of callMemo) if (Date.now() - m.at > 3600_000) callMemo.delete(k);
    promise.then(r => { if (!r.ok) callMemo.delete(memoKey); });
  }
  return promise;
}

// ---------- HTTP ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 100_000) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/voice(?=\/|$)/, '') || '/';
  try {
    if (req.method === 'POST') {
      // Only same-site pages may POST (the Authelia cookie would otherwise ride along).
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'cross-site request' });
    }
    if (path === '/api/session' && req.method === 'POST') return send(res, 200, await mint());
    if (path === '/api/ask' && req.method === 'POST') {
      const { request, task_id, steer } = await readBody(req);
      if (!request || typeof request !== 'string') return send(res, 400, { error: 'request required' });
      return send(res, 200, await ask(request.slice(0, 20000), task_id, !!steer));
    }
    if (path === '/api/tool' && req.method === 'POST') {
      const { name, args, call_id, picked } = await readBody(req);
      const pid = typeof picked === 'string' && /^[0-9a-f-]{36}$/i.test(picked) ? picked.toLowerCase() : null;
      return send(res, 200, await runTool(String(name || ''), args, typeof call_id === 'string' ? call_id : null, pid));
    }
    if (path === '/api/chats' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').slice(0, 200);
      try {
        return send(res, 200, { chats: (await searchChats(q, 25)).map(chatRow) });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (path === '/api/stop' && req.method === 'POST') {
      const { task_id } = await readBody(req);
      return send(res, 200, await stopTask(task_id));
    }
    if (path === '/api/tasks' && req.method === 'GET') return send(res, 200, { ...poolView(), tasks: recentTasks() });
    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify({ type: 'hello', ...poolView(), tasks: recentTasks() })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (path === '/api/debug' && req.method === 'GET') return send(res, 200, { model: MODEL, voice: VOICE, agent: AGENT_MODEL, instructions: INSTRUCTIONS, tools: TOOLS });
    if (path === '/api/debug/log' && req.method === 'POST') {
      const entry = await readBody(req);
      mkdirSync(join(HOME, '.local/state/voice-web'), { recursive: true });
      appendFileSync(DEBUG_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }).slice(0, 20000) + '\n');
      return send(res, 200, { ok: true });
    }
    if (path === '/healthz') return send(res, 200, { ok: true, ...poolView() });
    if (req.method === 'GET') {
      const file = path === '/' ? '/index.html' : path;
      const full = join(DIR, 'public', file);
      if (!full.startsWith(join(DIR, 'public')) || !existsSync(full)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(readFileSync(full));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[http]', path, e.message);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`voice-web on 127.0.0.1:${PORT}, model ${MODEL}, agent ${AGENT_MODEL}, up to ${MAX_WORKERS} workers`));
newWorker(); // one worker stays warm; more start when tasks overlap
