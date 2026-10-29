# voice: the Feather voice page

Built 2026-10-28. Open it from "Voice" in the Feather sidebar (`/voice/`, behind Authelia).
It runs as its own process (supervisord `voice-web`) from the deployed release:
`<release>/voice/server.js`.

## The pieces

1. **Browser page** (`public/index.html`, `public/app.js`). Tap Talk. The page gets the mic
   and opens a WebRTC call straight to OpenAI (`/v1/realtime/calls`). Audio does not pass
   through this computer. A data channel (`oai-events`) carries Realtime events: transcripts,
   tool calls and responses.
2. **Voice model**: OpenAI `gpt-realtime-2.1`, voice `marin`, semantic VAD (it decides when you
   finished a thought), `gpt-4o-mini-transcribe` for your side of the transcript. It is fast and
   chatty but cannot see the computer. Its instructions and tools live in `server.js`.
3. **voice-web server** (`server.js`, Node, no dependencies, supervisord `voice-web`,
   127.0.0.1:4930, Caddy `handle_path /voice/*`). It does three jobs:
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

- `find_chat(query)`: Feather's own search (`/api/sessions?q=`), or an id prefix. It returns up
  to 5 chats with a `busy` flag. Busy means the latest message is from the user or is a tool
  call, within 30 minutes. (`isActive` only says the tmux session is alive.) The voice workers'
  own `[voice] …` transcripts are hidden.
- `message_chat(chat, message, interrupt?)`: `POST /api/sessions/:id/send`, as you. It becomes a
  `kind: chat` task card with an "Open chat" link. The server polls `/messages` every 2 s and
  streams the chat's tool calls to the card. The reply counts as done when the latest message is
  assistant text with no tool call and nothing new comes for 8 s (cap 20 minutes). This works for
  any harness. A second message to a chat that is still replying joins the same task.
  `interrupt: true` first calls `/interrupt` (tmux C-c, and it stops autopilot).
  `ask_feather` with that task_id sends a follow-up into the chat. `stop_feather` only stops
  listening; it never touches the chat.
- `read_chat(chat)`: no LLM. The server returns the last 6 messages and, when the chat is busy,
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

- Logs: `~/.local/state/voice-web.log`, `~/.local/state/voice-web.err.log`.
- Restart: `supervisorctl -c /etc/supervisor/conf.d/supervisord.conf restart voice-web`.
- Supervisord runs `node /home/user/.local/share/feather/current/voice/server.js`, so a
  refeather ships it; restart `voice-web` after a promote to load the new code.
