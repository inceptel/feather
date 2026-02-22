# Feather

Lightweight frontend for AI coding agents.

Browse, manage, and interact with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Pi](https://github.com/anthropics/pi), and [Codex](https://github.com/openai/codex) sessions from a single UI. Includes JupyterLab, Claude CLI, and a full dev workspace out of the box.

## Quick Start

```bash
# Podman (recommended)
podman build -t feather .
podman run -p 8080:8080 -v ~:/home/user feather

# Docker (not recommended, terrible in general, avoid if possible)
docker build -f Containerfile -t feather .
docker run -p 8080:8080 -v ~:/home/user feather
```

Open `localhost:8080`. That's it.

Feather is at `/`, Jupyter is at `/jupyter/`.

## Environment Variables

Set these in `~/.env` or pass with `-e`:

| Variable | Description |
|----------|-------------|
| `FEATHER_ANTHROPIC_API_KEY` | Anthropic API key for title generation and memory |
| `FEATHER_OPENAI_API_KEY` | OpenAI API key for Whisper voice transcription |
| `FEATHER_PASSWORD` | Simple auth password (optional, recommended for remote) |

## What's Inside

- **Feather** — session viewer, real-time streaming, terminal access, voice input
- **JupyterLab** — notebooks at `/jupyter/`
- **Claude CLI** — spawn and manage coding sessions
- **Pi** — alternative coding agent
- **Codex** — OpenAI coding agent
- **tmux** — terminal multiplexer for background sessions

## Features

- **Session viewer** — browse and search session history across Claude CLI, Pi, and Codex
- **Real-time streaming** — SSE-based tailing of live sessions with byte-offset tracking
- **Terminal access** — spawn and interact with coding agents via embedded xterm.js
- **Voice input** — dictate prompts via OpenAI Whisper transcription
- **Image upload** — drag-and-drop screenshots and images into conversations
- **Multi-engine normalization** — all session formats normalized to a common JSONL schema

## Architecture

Feather is a Rust (axum) HTTP server with a single-file frontend (`static/index.html`). Sessions from different AI coding agents are watched and normalized into `~/sessions/{uuid}.jsonl`:

- **Claude CLI** sessions from `~/.claude/projects/`
- **Pi** sessions from `~/.pi/agent/sessions/` (tree-structured JSONL with parentId chains)
- **Codex** sessions from `~/.codex/sessions/`

The frontend connects via SSE for real-time updates. Terminal sessions run in tmux and stream via xterm.js. Caddy reverse-proxies all services behind a single port.

## Testing

```bash
npm install
npx playwright install chromium
npm test                    # E2E tests (Playwright)
npm run test:visual         # Visual regression tests (Claude vision)
npm run test:stagehand      # AI-powered tests (Stagehand)
```

## License

[Elastic License 2.0 (ELv2)](LICENSE) — free to use, modify, and redistribute. Cannot be offered as a managed service.
