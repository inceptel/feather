# Feather

**A lightweight, mobile-first viewer and controller for AI coding agents.**

Open any Claude Code session on your phone. Read the conversation. Send messages. Watch the terminal. Resume old sessions or spawn new ones — instantly.

<p align="center"><img src="docs/screenshots/session.png" alt="A Claude Code session rendered like a texting app, on mobile" width="320" /></p>

## Sidecars & loops — multi-agent, built in

Spin up a **second agent** with its own context, paired to your current session, and chat with it both ways. It's a Feather session like any other — persistent, resumable, visible in the UI — so you can read the conversation, jump in, or let two agents work it out.

![A generator and an independent evaluator arguing in the Sidecar tab](docs/screenshots/sidecar.png)

- **`/sidecar <task>`** — spawn a peer thread (claude *or* codex) and talk to it via a tiny `sidecar` CLI. Messages are brokered by Feather and injected straight into each agent's tmux; a per-session lock means two senders never garble a pane. → [`skills/sidecar`](skills/sidecar/SKILL.md)
- **`/looper <task>`** — the generator-evaluator loop: a generator builds, an **independent-context evaluator** opens and inspects the *real artifact* (renders the page, runs the tests — never trusts the builder's claims), and they loop until `[APPROVED]`. Separating the maker from the judge beats self-review. → [`skills/looper`](skills/looper/SKILL.md)

Agents talk over a tiny CLI — messages are recorded to a file and injected into the peer's session:

```bash
# from inside any agent session:
sidecar post --to evaluator "ready for review — landing page v2"
sidecar read        # print the whole thread
# the peer's reply is injected straight back into your session:
#   [sidecar message from evaluator] NOT APPROVED — the return arrow misses Generate by 62px...
```

The screenshot above is a real loop: an evaluator that rendered a webpage at two breakpoints, measured the DOM, and sent the generator back to fix a misaligned arrow — the harness pattern from Anthropic's long-running-agents work, running inside Feather.

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

## Rooms — durable workspaces

A Room is a folder under `~/rooms/` that gives related Feather chats a shared
working directory and durable notes. Rooms do not impose a special agent persona:
start or resume whichever Claude or Codex session is useful, and keep the context
that should survive any one chat in the room's `notes.md`.

The `room` CLI also provides optional delegation tools. Use `room council` when a
decision benefits from several sealed attempts and a judge; use `room lookup`,
`room second-opinion`, or `room spawn` when those workflows fit. None of them is
required to use a Room.

For finite autonomous work in Codex, the recommended path is `$goal-prep` followed
by `/goal`: prepare a bounded, verifiable goal, then let the Codex goal session run
it. This is not a cross-harness replacement for detached, indefinite loops.
Feather's former Auto surface has been retired, and existing `~/auto-*` directories
are left untouched.

## Slash commands

Feather ships Claude Code skills under [`skills/`](skills/). Symlink them into your Claude skills dir to use from any chat:

```bash
ln -sf "$(pwd)/skills/sidecar" ~/.claude/skills/sidecar
ln -sf "$(pwd)/skills/looper"  ~/.claude/skills/looper
ln -sf "$(pwd)/skills/feather" ~/.claude/skills/feather
ln -sf "$(pwd)/bin/sidecar"    ~/.local/bin/sidecar   # the sidecar CLI — must be on PATH
ln -sf "$(pwd)/bin/room"       ~/.local/bin/room      # optional Rooms CLI
```

- [`/sidecar`](skills/sidecar/SKILL.md) — spawn a paired peer agent thread and chat both ways.
- [`/looper`](skills/looper/SKILL.md) — run a generator-evaluator loop until `[APPROVED]`.
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

## Deploying changes

```bash
cd ~/feather
npm run deploy    # stamps version.json, builds frontend, restarts server
```

Both backend (`/api/health`) and frontend (tab bar) show the same version timestamp.

## Deployment

### supervisord

```bash
sudo cp infra/feather.supervisor.conf /etc/supervisor/conf.d/feather.conf
supervisorctl reread && supervisorctl update
```

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
