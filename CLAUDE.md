# Feather

Claude/Pi session viewer and manager. Rust (axum) server with single-page frontend.

## Architecture

Feather runs inside **podman containers** on a dedicated server. Nothing runs on the host except podman. Auth via Authelia, TLS via Traefik + Let's Encrypt.

See `CLAUDE.local.md` (gitignored) for specific infrastructure details (IPs, domains, ports).

## What It Does

- Browse Claude CLI and Pi coding agent session history from JSONL files
- Real-time SSE tailing of normalized JSONL files (byte-offset based)
- Spawn and manage Claude CLI and Pi instances via tmux
- Real-time terminal streaming (xterm.js)
- Voice input (OpenAI Whisper transcription)
- Screenshot/image upload

## Build & Deploy

### Local

```bash
./build.sh                      # compile + stamp version + restart locally
```

### Production

See `CLAUDE.local.md` for deployment commands and infrastructure details.

## Key Files

- `src/main.rs` - Axum HTTP server, API endpoints, SSE tailing, Pi/Claude spawn
- `src/tmux.rs` - tmux session management (spawn, send-keys, capture)
- `src/pi.rs` - Pi session JSONL parser (tree-structured context.jsonl → normalized messages)
- `src/normalizer.rs` - File watcher that normalizes Claude/Pi/Codex sessions into ~/sessions/
- `src/sessions.rs` - Session cache, normalized message types
- `static/index.html` - Entire frontend (single file)
- `build.sh` - Local build + restart script
- `.env` - Contains `FEATHER_OPENAI_API_KEY` and `FEATHER_ANTHROPIC_API_KEY`

## Session Architecture

Sessions from different engines are **normalized** into a common format in `~/sessions/{uuid}.jsonl`:

- **Claude CLI**: `~/.claude/projects/` → normalizer watches + converts
- **Pi**: `~/.pi/agent/sessions/` → normalizer watches + converts (tree-structured JSONL with parentId chain)
- **Codex**: `~/.codex/sessions/` → normalizer watches + converts

The normalizer rewrites the full normalized file on each change (Pi sessions can branch). SSE tailing detects mtime changes and re-reads from offset 0; frontend dedupes by UUID.

### Pi Session Spawn Flow

1. `POST /api/pi-new` returns instantly with `tmux_name` (no UUID yet)
2. Background task: waits for Pi prompt → sends bootstrap "hi" via CLI arg → polls for UUID
3. Frontend polls `GET /api/pi-resolve/{tmux_name}` until UUID resolves
4. Once resolved: maps UUID → tmux, starts SSE tailing, loads history

## Environment

- `PORT` - Server port (default 8080 inside container)
- `FEATHER_OPENAI_API_KEY` - For voice transcription (Whisper API)
- `FEATHER_ANTHROPIC_API_KEY` - For Haiku (memory extraction & title generation)
- `DEFAULT_CWD` - Working directory for new sessions (default `/home/user/projects/code`)

## Host Access

See `CLAUDE.local.md` for host mount details.
