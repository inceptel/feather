# Feather

**A lightweight, mobile-first viewer and controller for AI coding agents.**

Open any Claude Code session on your phone. Read the conversation. Send messages. Watch the terminal. Resume old sessions or spawn new ones — instantly.

<p align="center"><img src="docs/screenshots/session.png" alt="A Claude Code session rendered like a texting app, on mobile" width="320" /></p>

## Sidecars — multi-agent, built in

Spin up a **second agent** with its own context, paired to your current session, and chat with it both ways. It's a Feather session like any other — persistent, resumable, visible in the UI — so you can read the conversation, jump in, or let two agents work it out.

![Two agents collaborating in the Sidecar tab](docs/screenshots/sidecar.png)

- **`/sidecar <task>`** — spawn a peer thread (Claude *or* Codex) and talk to it through the `sidecar` CLI. Messages are brokered by Feather and injected into each agent's tmux; a per-session lock prevents two senders from garbling a pane. → [`skills/sidecar`](skills/sidecar/SKILL.md)

Agents talk over a tiny CLI — messages are recorded to a file and injected into the peer's session:

```bash
# from inside any agent session:
sidecar post --to peer "Please review the current approach."
sidecar read        # print the whole thread
# the peer's reply is injected straight back into your session.
```

The peer works in an independent context while sharing a visible, durable thread with the primary session.

## Make it yours

The whole thing is a handful of files — one backend (`server.js` + a few `lib/` modules), one app shell, a renderer, a terminal. Point Claude (or any AI agent) at this repo and tell it what you want:

- *"Add a cost tracker that shows tokens and dollars per session"*
- *"Add push notifications when an agent needs my attention"*
- *"Show me a diff view when Claude edits a file"*
- *"Add a dark/light theme toggle"*
- *"Group consecutive tool calls into a collapsible block"*
- *"Add Codex support — here's how their session files work"*
- *"Add a search bar that filters across all sessions"*
- *"Show a green typing indicator when Claude is responding"*
- *"Add keyboard shortcuts — j/k to navigate sessions, Enter to open"*

No abstractions to learn. No plugin API to read. One backend, one app shell, one renderer. You describe it, the agent builds it.

## Fork and share

Feather is designed to diverge. Fork it, make it yours, share what you build.

```bash
# Fork on GitHub, then:
git clone https://github.com/YOU/feather.git && cd feather
npm install && npm start
# hack away
```

**Pulling from other forks:**

```bash
# Add someone's fork as a remote
git remote add phil https://github.com/phil/feather.git
git fetch phil

# See what they've been up to
git log phil/main --oneline

# Grab specific commits
git cherry-pick <sha>

# Or merge everything
git merge phil/main
```

**Contributing back:**

Open a PR to `inceptel/feather` from your fork. Or don't — your fork is yours.

## Why

You're running Claude Code on a remote machine. You want to check on it from your phone, your iPad, another laptop. You want to send a follow-up message without SSH-ing in. You want to see the conversation rendered beautifully — like a texting app, not a terminal dump.

Feather reads Claude's raw JSONL session files, streams updates via SSE, and connects to tmux sessions via WebSocket terminals. No database. No build pipeline beyond Vite. Just `node server.js`.

### OMP live execution mirror

OMP sessions remain normal interactive TUI processes in tmux, so Terminal mode
is always available for direct intervention. A bounded protocol-v4 extension
mirrors live reasoning, tool start/update/end events, Todo state, approvals,
jobs, and nested subagent events into Chat. **Details** renders the parent run as
one chronological timeline; each subagent is a selectable child with its own
Todo and execution inspector. Current state is replayed after browser reconnects,
while the durable JSONL transcript remains the historical source of truth.

Production OMP launches can isolate mutable runtime state by setting
`FEATHER_OMP_AUTH_GATEWAY_URL` to an `omp auth-gateway` endpoint. Feather then
sets a stable `PI_CODING_AGENT_DIR=~/.feather/omp-agents/<session-id>` for each
session, routes model calls through the gateway's canonical token file
(`~/.omp/auth-gateway.token`, override with
`FEATHER_OMP_AUTH_GATEWAY_TOKEN_FILE`), and starts Room staff without the legacy
SQLite launch delay. The gateway keeps provider access tokens out of those
directories; its upstream `omp auth-broker` is the sole writer of the shared
credential database. `infra/feather.supervisor.conf` includes the three-process
broker → gateway → Feather launch order. Without the gateway URL, Feather keeps
the shared OMP directory and conservative launch stagger for compatibility.

## Rooms — durable workspaces

A Room is a folder under `~/rooms/` that gives related Feather chats a shared
working directory and durable notes. Rooms do not impose a special agent persona:
start or resume whichever Claude, Codex, or OMP session is useful, and keep the context
that should survive any one chat in the room's `notes.md`.

Each Room has one durable **Main** chat. Tapping the Room always opens that chat,
regardless of which background or historical chat spoke most recently. Expanding
the card keeps Main first and shows only four other chats; **Manage other chats**
reveals the full history plus Make main and Detach actions.

A Room is created from one mission sentence, in the user's own words:

```bash
room new ev-shop --mission "build me a business plan for an EV-only auto shop at 815 3rd St"
```

Feather scaffolds the folder (`AGENTS.md` with the mission verbatim, one charter
per resident, `notes.md`, `wiki/Home.md`), opens an OMP Leader, and registers
three OMP Ralph residents: a **caretaker** that wakes every 15 minutes and keeps
`wiki/` current from the other sessions' logs, an **updater** that wakes every
30 minutes and decides what is worth publishing to Super Feed, and a
**marketer** the updater briefs over Sidecar to write the card and render its
image with `room visual` (Gemini through `~/gemini.py`, with a plain text card as
the fallback). The Leader receives the mission as its first message. A resident
that ends a wake with `RALPH_COMPLETE` simply sleeps until its next slot.
`room new <name>` without a mission scaffolds the same files locally and starts
nothing; the Rooms home's **New room** button asks for the mission as well.

Each Super Feed card has a **Comment** box. A comment goes to that Room's
Leader as a tagged chat message, and the Leader's next reply is shown under the
card. Comments are kept in the instance state and never appear as feed cards.

By default, Feather checks each inactive Room every 15 minutes and launches one
non-interactive OMP session to do the next useful thing. The Room card shows when
it last worked and when it will check again. Pause or resume that behavior from
the card, or from inside the Room with `room pause` and `room wake`.

Rooms retain `updates.jsonl` as legacy append-only evidence. The user-facing
Updates feed and unread badge were removed: the Room caretaker now distills
durable meaning from `notes.md`, legacy updates, and sessions into curated
`wiki/` pages. `room update` and `room updates` remain available for
compatibility, but agents should write working evidence to `notes.md` and leave
human-facing synthesis to the caretaker.

The Rooms home starts with **Super Feed**, a read-only projection of canonical
Leader-chat outcomes, authenticated Updater publications, active Room status
failures, and explicitly keyed, structured `#friction` records. **Latest**,
**Review**, **Following**, and **Friction** are views over the same stable
evidence identities; following only changes selection. Review currently means
an explicit active system alert: user-message rows may say `asked`, but they do
not claim unresolved human attention without durable approval or decision
evidence. Cards link back to their source, retain stale locators when a source
disappears, and never expose raw notes, unkeyed legacy complaints, legacy
Updates, Sidecar traffic, or tool activity. An Updater classifies each selected
publication as a **Briefing** when it changes a decision or action, or **By the
way** when it adds useful, evidence-backed context without asking for action.
By-the-way items stay out of Review, create no alert badge, and do not require a
visual. Selected publications may include a validated Room-local PNG, JPEG, or
WebP through the authenticated publication route; remote images and symlink
escapes are rejected. Complaint status remains unknown unless a canonical
resolution event proves otherwise.


The client conditionally polls with ETags every 10 seconds and preserves its
last-good view on a transient failure. The Room and feed projections each use a
10-second stale-while-refresh cache, so that polling interval is not a hard
freshness bound. Feed history beyond the latest eight reconstructed Leader
messages per Room is process-local best effort and resets on server restart.
Updater publications are append-only Room evidence and survive restarts.


`room note` records evidence but does not wake another session. For actionable
cross-session work, use a stable delivery id:

```bash
printf '%s' 'Review the new receipt and act if justified.' \
  | room dispatch --id source-item-123 --to caretaker --stdin
```

`room dispatch` appends one `[dispatch:<id>]` note, resolves the named permanent
resident, and uses Feather's idempotent session delivery to wake it immediately.
Retries with the same id do not duplicate the note or resident input, and
delivery does not depend on the Room's automatic pulse being enabled. Room
Sidecar posting remains resident-only; assigned non-resident chats use
`room dispatch` for a supported handoff.

A registered `updater` OMP Ralph may publish one selected item from a JSON
object using `room publish FILE`. The command presents its per-session bridge
capability; the server binds that capability to the Room's current Updater,
enforces stable evidence identity and idempotency, then refreshes Super Feed.
Requests without the
current Updater capability are rejected. The current shared-UID deployment is
an organizational boundary, not protection from another local process.

Agents can run `room complain "..."` to append recurring annoyances to
`#friction`. `#meta` is the separate place for reusable lessons across Rooms.

The `room` CLI also provides optional delegation tools. Use `room council` when a
decision benefits from several sealed attempts and a judge; use `room lookup`,
`room second-opinion`, or `room spawn` when those workflows fit. None of them is
required to use a Room.

For finite autonomous work in Codex, the recommended path is `$goal-prep` followed
by `/goal`: prepare a bounded, verifiable goal, then let the Codex goal session run
it. This is not a cross-harness replacement for detached, indefinite loops.

## Ralph — cross-harness long-running agents

Open the **New Session** menu, then choose **Ralph · Claude Code**, **Ralph ·
Codex**, or **Ralph · OMP**. Feather installs the same autonomous-owner system
instructions on every launch and resume. At each verified turn completion,
Feather reads the harness's native JSONL boundary and delivers an internal
continuation callback, so the loop survives ordinary turn exits and tmux
restarts without harness-specific stop hooks.

Ralph state is durable per session: the UI shows waiting, working, scheduled,
blocked, complete, stopped, or error status plus the completed callback
iteration. **Stop Ralph** disables pending callbacks; **Resume Ralph** restarts
them. An agent pauses at a true human boundary with `RALPH_BLOCKED: <smallest
concrete unblock request>`, or finishes a fully exhausted objective with
`RALPH_COMPLETE: <completed outcome>`. Callback delivery retries four times
with bounded backoff, then stops in a visible error state instead of looping
silently.

The built-in callback only continues the selected session. It does not execute
arbitrary callback commands or webhooks; external, destructive, privileged,
financial, credential, and production actions remain subject to the authority
and safety limits in the Ralph system instructions.

## Agent capabilities

Install the promoted Feather and Sidecar skills for both Claude and Codex, plus the
`room`, `sidecar`, and `refeather` CLIs, through the guarded installer. Point
the links at the stable `current` release so one promotion updates server and
agent capabilities together:

```bash
bin/refeather install-capabilities \
  --release /opt/feather/releases/<commit> \
  --target-root /opt/feather/current
```

The installer is idempotent. It never overwrites a file or foreign symlink;
conflicts are copied to a timestamped evidence directory and installation
stops with cleanup guidance. Ensure `~/.local/bin` is on the environment used
to spawn Claude and Codex sessions.

- [`/sidecar`](skills/sidecar/SKILL.md) — spawn a paired peer agent thread and chat both ways.
- [`/feather`](skills/feather/SKILL.md) — manage the running Feather server (status, logs, quick links, deploy).

## Quick start

```bash
npm install inceptel/feather
cd node_modules/feather && npm start
```

Or from source:

```bash
git clone https://github.com/inceptel/feather.git && cd feather
npm install    # installs deps + builds frontend automatically
npm start      # → Feather on http://localhost:4870
```

## Persistent state

By default Feather keeps its instance metadata beside `server.js`, exactly as
older releases did. Set `FEATHER_STATE_DIR` to an absolute path to make release
checkouts disposable while preserving the instance's metadata and uploads:

```bash
FEATHER_STATE_DIR=/srv/feather/state npm start
```

The configured state root owns only these instance assets:

| Asset | Contents |
|------|----------|
| `boxes.json` | Remote-box endpoints and credentials (secret, enforced `0600`) |
| `sharing.json` | Peer grants and credentials (secret, enforced `0600`) |
| `session-meta.json` | Per-session names, archive state, and sharing metadata |
| `project-labels.json` | Project display labels |
| `quick-links.json` | Saved navigation links |
| `starred.json` | Starred sessions |
| `uploads/` | Uploaded attachments |

Everything else keeps its existing owner: release assets (`static/`,
`version.json`, and the bridge extension) stay in the checkout; sidecars, Room
assignments, access logs, and OMP state stay under `~/.feather`; Claude and Codex
session stores stay under their harness homes; Rooms stay under `~/rooms`; and
tmux/process/temp state remains runtime-managed. A new writable path must be
classified into one of those groups before it is added.

For a migration, stop all Feather writers, copy and validate the seven instance
assets, then start one release with `FEATHER_STATE_DIR`. Deployment tooling may
create checkout-local compatibility symlinks for older releases, but it must
only create missing links: an existing file or a link to another target is a
hard conflict and must never be replaced automatically. `boxes.json` and
`sharing.json` targets must remain owner-only through that process.

The current JSON files retain their existing unversioned shapes. A release that
changes a state shape must introduce an explicit schema/version and document its
downgrade behavior before writing it. Rollback after new writes must use the
compatible current state or a tested downgrade adapter; restoring a pre-upgrade
copy at that point would lose work. Do not run incompatible writers against the
same root.

Durable JSON writes use a same-directory fsynced temporary file and atomic
rename, retain a `.last-good` recovery copy, and fail closed on malformed
existing state. Defaults and rollback compatibility are recorded in
[`docs/state-compatibility.md`](docs/state-compatibility.md).

## Architecture

```
┌─────────────────────────────────────────┐
│  iPhone / Browser                       │
│  SolidJS SPA                            │
│  ├── MessageView (markdown, bubbles)    │
│  ├── Terminal (xterm.js + WebSocket)    │
│  └── Chat input (auto-grow textarea)   │
└──────────┬──────────────────────────────┘
           │ HTTP + SSE + WS
           ▼
┌──────────────────────────────────────────┐
│  Express server                          │
│  ├── JSONL parser (parseMessage)        │
│  ├── Session discovery (2-phase scan)   │
│  ├── SSE broadcaster (byte-offset IDs)  │
│  ├── fs.watch (inotify, per-directory)  │
│  ├── tmux manager (spawn/resume/send)   │
│  └── WebSocket terminal (node-pty)      │
└──────────┬──────────────────────────────┘
           │ filesystem
           ▼
  ~/.claude/projects/<hash>/<session>.jsonl
  tmux sessions: feather-<8chars>
```

## Files

| File | Purpose |
|------|---------|
| `server.js` | Backend entry — API, SSE, WebSocket, JSONL parsing, tmux |
| `lib/` | Backend modules — JSONL parsers, session discovery, the sidecar broker (`sidecar.js`) + send lock (`sendlock.js`) |
| `frontend/src/App.tsx` | UI shell — sidebar, header, tabs, input bar |
| `frontend/src/api.ts` | REST + SSE client, types |
| `frontend/src/components/MessageView.tsx` | Chat bubbles with markdown rendering |
| `frontend/src/components/Sidecar.tsx` | Sidecar panel — paired-agent thread view |
| `frontend/src/components/Terminal.tsx` | xterm.js + WebSocket terminal |
| `frontend/src/index.tsx` | SolidJS mount point |

## Design decisions

- **No database.** Read JSONL directly. The filesystem is the source of truth.
- **No polling.** `fs.watch` → SSE push. Client generates session UUID upfront (ClOrdId pattern).
- **tmux as the process manager.** Every Claude session runs in a named tmux session. Terminal tab attaches to it. Chat input sends keystrokes via `send-keys` / `paste-buffer`.
- **Two-phase session discovery.** Stat-only scan + sort by mtime → read first 4KB of top N for titles. 7000+ sessions in 75ms.
- **Byte-offset SSE IDs.** Enables resumable streams and gap-free message delivery.
- **Mobile-first.** `--vh` viewport fix, safe-area insets, `-webkit-overflow-scrolling: touch`, PWA meta tags.

## X bookmark intake

`bin/x-bookmark-dispatcher --loop` polls the authenticated read-only `x`
wrapper every 15 minutes. It normalizes new bookmarks, resolves only bounded
HTTP(S) redirects, and writes owner-only receipts under
`~/.feather/x-bookmarks/`. `#x-bookmarks` owns canonical intake and lifecycle;
the dispatcher writes its review item there, then adds a provenance-preserving
referral to the classified destination Room. Bookmarks and linked content are
always untrusted evidence: the dispatcher never installs or executes code,
writes to X, or performs a linked action. Skill candidates and name collisions
remain review-only.

Supervisor configuration lives in
`infra/x-bookmark-dispatcher.supervisor.conf`. State includes a durable cursor,
oldest-unseen-first bounded processing, a single-flight lock, and surfaced
retry/backoff status.

## Releasing changes

```bash
cd ~/feather
npm run deploy    # stages an immutable release; does not restart anything
```

Promotion is a separate, guarded operation with explicit current-link,
Supervisor, and mounted health inputs. It owns a host lock, persists every
phase, verifies the expected build version, and restores the prior release on
failure. See [`docs/runbooks/refeather.md`](docs/runbooks/refeather.md).

Both backend (`/api/health`) and frontend (tab bar) show the promoted version timestamp.

## Deployment

### supervisord

```bash
sudo cp infra/feather.supervisor.conf /etc/supervisor/conf.d/feather.conf
supervisorctl reread && supervisorctl update
```

Customize the template first. Production must execute one stable `current`
link and keep mutable metadata in `FEATHER_STATE_DIR`; never point Supervisor
at a personalized source checkout.

### Reverse proxy (Caddy)

```
handle /feather { redir /feather/ permanent }
handle /feather/api/* {
    uri strip_prefix /feather
    reverse_proxy localhost:4870 {
        flush_interval -1    # required for SSE
    }
}
handle /feather/* {
    uri strip_prefix /feather
    reverse_proxy localhost:4870
}
```

## Dependencies

**Backend:** express, node-pty, ws
**Frontend:** solid-js, @xterm/xterm, @xterm/addon-fit, marked, dompurify

## License

[Elastic License 2.0](LICENSE) — free to use, modify, and distribute. Cannot be offered as a hosted service.
