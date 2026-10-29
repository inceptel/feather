# voice: the Feather voice page

Built 2026-10-28. Open it from "Voice" in the Feather sidebar (`/voice/`, behind Authelia).
Feather starts it when `FEATHER_VOICE=1` is set. It runs as Feather's child process, on its own
port, so a Voice crash restarts Voice only (`lib/voice-process.js`).

## The pieces

1. **Browser page** (`public/index.html`, `public/app.js`). Tap Talk. The page gets the mic
   and opens a WebRTC call straight to OpenAI (`/v1/realtime/calls`). Audio does not pass
   through this computer. A data channel (`oai-events`) carries Realtime events: transcripts,
   tool calls and responses.
2. **Voice model**: OpenAI `gpt-realtime-2.1`, voice `marin`, semantic VAD (it decides when you
   finished a thought), `gpt-4o-mini-transcribe` for your side of the transcript. It is fast and
   chatty but cannot see the computer. Its instructions and tools live in `server.js`.
3. **voice-web server** (`server.js`, Node, no dependencies, a child process of Feather,
   127.0.0.1:4930 (`FEATHER_VOICE_PORT`), Caddy `handle_path /voice/*`). It does three jobs:
   - Mints a short-lived Realtime key (`POST /api/session`). It uses the Codex ChatGPT login in
     `~/.codex/auth.json` first, then `OPENAI_API_KEY` as a fallback (environment, else
     `VOICE_ENV_FILE`, else `~/.config/feather/voice.env`; never in this repo). The real credential never
     reaches the browser. The key carries the session config (model, voice, instructions, tools).
   - Runs a **pool of warm workers**, up to 4 (`MAX_WORKERS`). Each is `pi --mode rpc
     --model claude-bridge/claude-opus-5-5` (Claude Opus 5.5 through the Max plan bridge) with a
     fixed session id: `voice-agent`, `voice-agent-2`, and so on. One worker is always warm. More
     start when tasks overlap, and they stay warm. A crashed worker restarts with backoff.
   - Tracks **tasks**. Each `ask_feather` call becomes task #N. A new task takes any idle worker,
     or waits in a queue. A follow-up on #N (with `task_id`) goes to the worker that ran #N, so it
     keeps that context.
   - Streams task activity to the page over SSE (`GET /api/events`): start, text, tools, done.
4. **Workers** (Claude Opus 5.5) do the real work: shell, files, web, email/calendar CLIs, wiki,
   memory. Their extra system prompt is `agent-voice-prompt.md`. It calls them "Feather" and
   asks for spoken replies under 40 words. They work in `~/projects/voice-agent/`.
5. **Feather integration**: `bin/feather` is on pi's PATH. It calls the Feather API on
   127.0.0.1:3300: `chats`, `read`, `peek` (live terminal), `send` (talk into an existing chat), `new` (start a new
   agent chat, which is how a worker spawns sub-agents), `rooms`. The page links back to Feather,
   and "Sessions" opens Pi Web, which shows the full worker sessions.

The voice model never hears the word "pi". To it, the workers are just "Feather".

## One request, end to end

1. You speak. OpenAI transcribes it, and the voice model decides it needs the computer.
2. It calls `ask_feather(request)`, once per separate task. Two asks in one breath make two
   calls. The page sends each to `POST /api/ask`.
3. The server makes task #N, gives it to a worker, and returns the number at once. The voice
   model says "On it." once. You can keep talking.
4. Workers run in parallel. The page shows one card per task, with live tools and text.
5. A worker settles. The server sends `task_done` over SSE. The page adds "Feather #N done …
   Result …" to the voice conversation and asks for a one-sentence gist.
6. The voice model speaks it.

Other tools: `feather_status` (what is running), `stop_feather(task_id?)` (cancel one or all).
Typing with no call open makes a task directly.

## Talking to existing Feather chats

- **The picked chat.** The "Talking to" bar at the top picks one chat by tap: recent chats
  (green dot = open now), a search box, and the last 3 picks as one-tap chips. The pick lives in
  the browser (`localStorage`) and goes with every tool call as `picked`. `message_chat` and
  `read_chat` use it when no chat is named. A system note tells the voice model which chat is
  picked, at call start and on every change. `pick_chat(chat)` picks one by voice ("switch to the
  Alexa chat"). The page's list comes from `GET api/chats?q=`.
- **Chat search** (`searchChats`, shared by the picker, `find_chat` and name lookups): Feather's
  own search (`/api/sessions?q=`) on the query minus filler words. Feather needs every word to
  match, so when that finds fewer than 3 chats, each word is also searched on its own. Ranking:
  words at the start of a title word first, then words matched in the content, then recency. So
  "the Alexa chat" finds "Alexa replacement", and "disaster kit Amazon" still finds the
  emergency supplies chat. Voice workers' `[voice] …` transcripts and sidecars are hidden.
  A name resolves when one title has every word he said.
- `find_chat(query)`: that search, or an id prefix. It returns up to 5 chats with a `busy` flag.
  Busy means the latest message is from the user or is a tool call, within 30 minutes.
  (`isActive` only says the tmux session is alive.)
- `message_chat(chat?, message, interrupt?)`: `POST /api/sessions/:id/send`, as you. It becomes a
  `kind: chat` task card with an "Open chat" link. The server polls `/messages` every 2 s and
  streams the chat's tool calls to the card. The reply counts as done when the latest message is
  assistant text with no tool call and nothing new comes for 8 s (cap 20 minutes). This works for
  any harness. A second message to a chat that is still replying joins the same task.
  `interrupt: true` first calls `/interrupt` (tmux C-c, and it stops autopilot).
  `ask_feather` with that task_id sends a follow-up into the chat. `stop_feather` only stops
  listening; it never touches the chat.
- `read_chat(chat?)`: no LLM. The server returns the last 6 messages and, when the chat is busy,
  its live screen (`tmux capture-pane` of `feather-<id8>`). The voice model answers from that.
  Nothing is sent into the chat.
- `create_chat(task?, title?, agent?)`: no LLM. `POST /api/chats {requestId}` with no options takes a
  warm standby chat at once (`agent: codex` means a cold start). Then rename to the title, and send
  the task through `/send` as a normal first message, the same as typing it. Like typing, that lets
  the chat start ongoing work if it decides to; it does not turn it on. The request id and the
  send's message id derive from the voice call id, so a retried call never makes two chats or
  sends the task twice. The same request within 60 s also returns the first result.

### Typed results

All tools go through one endpoint, `POST /api/tool {name, args, call_id}`, so they can be tested
with curl. Every result is `{ok: true, say, ...data}` or
`{ok: false, say, error: {code, message, retryable, choices?}, chat?}`. Codes: `bad_args`,
`not_found`, `ambiguous_chat` (with `choices`), `starting`, `timeout`, `refused`, `backend`.
Worker tasks that end in a model error (`stopReason: "error"`, or `auto_retry_end` with
`success: false`) finish as `status: "error"` with `refused` (safety filter) or `backend`, never
as a result. Worker tests on a fake pi: `node voice/test/workers.test.mjs`.

### Worker sessions

Each worker task runs in its own pi session (`new_session`, then `get_state` saves its file).
A follow-up on a finished task reopens that file with `switch_session`, on any idle worker.
So one bad context (for example a refused topic) cannot spill into the next task. This was the
cause of the 2026-10-28 failures: one long session was flagged, and every later request on it
was refused, even "create a new chat".

Tested 2026-10-28 on a throwaway Claude chat: send and reply (27 s), the side question while
it was busy (18 s), interrupt then message, and the voice model choosing all three tools from
typed requests.

## Debugging

- **Debug** (header) shows every tool call the voice model makes in the log: name, arguments,
  result, milliseconds, and "no tool call" when it answered by itself. It is remembered per browser.
- **Tools** shows the exact tools and instructions the voice model gets (`GET /api/debug`).
- Every call is also written to `~/.local/state/voice-web/toolcalls.jsonl` with the words that
  caused it (`heard`), so wrong calls can be reviewed later.

## Safety

- Behind Authelia. POSTs with a cross-site `Sec-Fetch-Site` header get a 403.
- Both prompts say: no email, public posts, spending or deletes without a spoken yes.
- Worker dialogs (select/confirm) are auto-cancelled, because voice cannot answer them.

## Limits

- A Realtime call lasts at most 60 minutes. Workers keep running between calls.
- Up to 4 workers means up to 4 Opus sessions at once on the Max plan. More tasks wait their turn.
- The Codex-login path for Realtime is undocumented. If it breaks, set `VOICE_AUTH=apikey`
  and give the server `OPENAI_API_KEY`.
- Cost: audio is $32 in / $64 out per 1M tokens on `gpt-realtime-2.1`. With the Codex
  login, billing to the ChatGPT plan is not confirmed.

## Run and roll back

- Turn it on: set `FEATHER_VOICE=1` in Feather's environment. Read-only Feather never starts it.
- Feather starts Voice when it starts and stops it (and its workers) when it stops. So a
  refeather or a Feather restart also restarts Voice. That ends an open call and its tasks.
- If Voice exits, Feather starts it again after 1 s, then 5 s, then every 30 s.
- Voice gets the user's environment without Feather's own `FEATHER_*` settings, plus `PORT`
  and `FEATHER_URL` (this Feather), which `bin/feather` uses.
- Feather keeps the Voice pid in `<state dir>/voice.pid`. After a hard crash, the next Feather
  stops the Voice that was left behind before it starts a new one.
- Logs: Feather's log, each line marked `[voice]`.
