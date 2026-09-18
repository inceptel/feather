---
name: auto
description: Turn the current Feather chat into ongoing autonomous work, stop it, attach or detach a reviewer, schedule a recurring nudge, or list the running autos. Use when the user says /auto, "keep working on this", "autopilot", "stop working", or asks which autos are running.
---

# /auto — ongoing work for this chat

Commands, all run from inside the chat they apply to:

| Command | Effect |
|---|---|
| `/auto <objective>` | Keep working on this chat's objective until stopped (same as the ⋯ menu "Keep working") |
| `/auto stop` | Back to an ordinary chat (same as ⋯ "Stop working") |
| `/auto review` | Attach one Reviewer to this chat (same as ⋯ "Attach reviewer") |
| `/auto review off` | Detach the Reviewer (same as ⋯ "Detach reviewer") |
| `/auto every <duration>: <task>` | Inject `<task>` into this chat every `<duration>` while the rule is enabled |
| `/auto every off` | Delete this chat's recurring rules |
| `/auto status` | Read-only table of every auto and rule; also at `<Feather>/autos.html` |

Everything the skill does goes through Feather's own routes, so the UI's Stop
button, the ⋯ menu and the `autos.html` table always see it. Never start a
timer, `/loop`, cron, or any other continuation Feather cannot see.

## Environment

Feather sets these on every session it launches:

- `FEATHER_SESSION_ID` — this chat's id
- `FEATHER_URL` — the loopback origin of this Feather instance (`http://127.0.0.1:<port>`)
- `FEATHER_BRIDGE_URL`, `FEATHER_BRIDGE_TOKEN` — used by the workflow CLI
- the workflow CLI path is given in the system prompt as `bin/feather-workflow.mjs`; call it `$WF` below

If `FEATHER_SESSION_ID` or `FEATHER_URL` is missing, say **"/auto is not
supported on this chat"** and do nothing else. Do not discover a server by
port scanning or by reading other config.

Read the chat's kind once per invocation:

```bash
node "$WF" read
```

| Outcome | Meaning | What to do |
|---|---|---|
| JSON with `generation` | this chat may control its own ongoing work (a chat from **New chat**, solo or paired, or a plain session) | proceed |
| stderr `Only the conversation creator can control ongoing work` (403) | this is a Reviewer session | say so; only the creator chat can run `/auto` |
| stderr `Room and helper sessions cannot control ongoing work here` (403) | a Room Leader, resident, or communications helper | say so; Rooms are driven by their own schedules |
| stderr `Run inside a Feather Creator session with its bridge capability.` | no bridge env | "not supported on this chat"; do nothing |
| anything else (network, 404, 5xx) | Feather unavailable or unknown | report the error and stop; do not assume |

## `/auto <objective>` — start

1. `read` → note `generation`.
2. Derive objective, constraints and the first outcome **from the conversation**.
   If `/auto` came with no text and nothing has been discussed, ask one concrete
   question. Never invent an objective.
3. Echo three short lines (objective, constraints, first outcome) so a wrong
   reading is cheap to stop.
4. Write the JSON to a file (apostrophes break inline shell JSON) and start:

```bash
node "$WF" start --file /path/to/start.json
# {"generation":<n>,"objective":"…","constraints":["…"],"next":"…"}
```

The response carries `instructions`: the ongoing-work rules for this chat.
Follow them from that turn on (checkpoints with `progress`, phases, the
`RALPH_*` boundary lines they describe).

Rules:

- `start` needs a human instruction in the same turn (409 "A new human
  instruction is required to start work" otherwise). Report a 409 and stop.
  **Never** re-run `read` for a fresh generation and retry: that would
  override a newer human stop.
- Repeating `start` with the same objective, constraints and next is a no-op.
  A new objective replaces the old one.
- On a chat that was not already in ralph mode, Feather records the previous
  mode so `/auto stop` can restore it.

## `/auto stop`

```bash
node "$WF" stop '{}'
```

Feather cancels the pending continuation, disables the workflow and the Ralph
callback, restores the chat's previous mode (a chat born in ralph mode keeps
it), stops and disables this chat's recurring rules, and injects a short
"Ongoing work stopped" note into the chat if it is still live. From that
message on, behave as an ordinary chat: answer and wait, no `RALPH_*` lines,
no self-continuation. Any Reviewer stays attached; use `/auto review off` to
detach it.

Stop does not interrupt the turn in flight; that is the UI Interrupt button.

## `/auto review` and `/auto review off`

```bash
curl -sS -X POST -H 'Content-Type: application/json' -d '{"reviewPolicy":"adaptive"}' \
  "$FEATHER_URL/api/chats/$FEATHER_SESSION_ID/reviewer"
curl -sS -X DELETE "$FEATHER_URL/api/chats/$FEATHER_SESSION_ID/reviewer"
```

- Attach spawns exactly one Reviewer, primes it with the Creator–Reviewer
  contract and then injects the pair instructions into this chat. Follow those
  instructions from then on. Already paired → `{"attached":false}` and the
  existing pair; never a second reviewer. 409 means an attach is already in
  flight or the chat is still starting: wait, do not retry in a loop.
  503 "Reviewer priming not verified" means the reviewer was torn down again;
  report it.
- Detach kills the Reviewer session, tears down the sidecar group, sets the
  review policy back to `none` and injects "Reviewer detached. Ignore the
  Creator–Reviewer instructions; there is no reviewer to consult." Follow that.
- Both routes only work for this chat's own id and only for a creator chat.
  404 "Chat not found" on a plain session or a reviewer means review is not
  available there.

## `/auto every <duration>: <task>`

Recurring rules for chats live under the reserved scheduler room `chats`, one
namespace per owning chat. Rule ids are `chats/<name>`; use a short name
derived from the task, prefixed with the first 8 characters of this chat id so
different chats never collide (`chats/5760d093-standup`).

```bash
curl -sS -X PUT -H 'Content-Type: application/json' --data @rule.json \
  "$FEATHER_URL/api/scheduler/rules/chats/<name>"
# rule.json: {"target":{"kind":"session","sessionId":"<FEATHER_SESSION_ID>"},
#             "mode":"inject","every":"2h","prompt":"<task>","note":"<why>"}
```

- `every` is a duration of at least 1 minute (`30m`, `2h`); `cron` runs in UTC;
  use one or the other.
- The rule may only target this chat (`ownerSessionId` defaults to the target
  and must equal it). 404 "no such chat" means this session cannot own rules.
- A rule never overlaps its own in-flight run; missed windows coalesce into one.
- Injection headers read `[Scheduled · chats/<name> · <time>]`; treat them as
  the user's standing instruction for that task and answer as an ordinary turn
  unless ongoing work is running.
- `/auto stop` disables this chat's rules; they stay listed as disabled.
  `/auto every off` deletes them:

```bash
curl -sS "$FEATHER_URL/api/scheduler?room=chats"     # find this chat's rules
curl -sS -X DELETE "$FEATHER_URL/api/scheduler/rules/chats/<name>"
```

Rule actions: `POST …/rules/chats/<name>/{stop|pause|resume|fire}`. `stop`
disables the rule and stops its run; `pause` keeps it enabled but paused;
`resume` re-enables and restarts the clock; `fire` runs now or 409s with the
skip reason. Do not blur stop-the-run and disable-the-rule when reporting.

## `/auto status`

Read-only. Two GETs, nothing else:

```bash
curl -sS "$FEATHER_URL/api/sessions?mode=ralph&limit=300"
curl -sS "$FEATHER_URL/api/scheduler"
```

Print one line per chat: state → title → objective (or "no objective
recorded") → `/#<id>`. Order: blocked (with the reason) → working → reviewing
→ waiting → error → stopped/complete. Then rules, enabled first. `ralph.enabled`
false with status `blocked` is still **blocked** (the callback is off because
a human must answer). A missing `ralph` object, or `enabled:true` with no
status, is **unknown**, not working and not stopped. Point the user at
`$FEATHER_URL/autos.html` (or the same path on the public host) for the
live table with token usage.

## What this skill never does

- Install itself or edit `~/.claude/skills/`, `~/rooms/**`, or `~/feather`.
- Start any continuation the Feather Stop button cannot see.
- Retry a 409 with a refreshed generation.
- Act on another chat's id, or spawn a second reviewer.
