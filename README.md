# Feather

Lightweight frontend for AI coding agents.

Browse, manage, and interact with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Pi](https://github.com/anthropics/pi), and [Codex](https://github.com/openai/codex) sessions from a single UI. Rust backend, single-file frontend, real-time streaming.

## Features

- **Session viewer** — browse and search session history across Claude CLI, Pi, and Codex
- **Real-time streaming** — SSE-based tailing of live sessions with byte-offset tracking
- **Terminal access** — spawn and interact with coding agents via embedded xterm.js
- **Voice input** — dictate prompts via OpenAI Whisper transcription
- **Image upload** — drag-and-drop screenshots and images into conversations
- **Multi-engine normalization** — all session formats normalized to a common JSONL schema

## Quick Start

```bash
# Prerequisites: Rust toolchain, Node.js (for tests)
git clone https://github.com/inceptel/feather.git
cd feather

# Configure
cp .env.example .env  # add your API keys

# Build and run
cargo build --release
./run.sh
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default 8080) |
| `FEATHER_OPENAI_API_KEY` | OpenAI API key for Whisper voice transcription |
| `FEATHER_ANTHROPIC_API_KEY` | Anthropic API key for title generation |
| `DEFAULT_CWD` | Working directory for new sessions |

## Architecture

Feather is a Rust (axum) HTTP server with a single-file frontend (`static/index.html`). Sessions from different AI coding agents are watched and normalized into `~/sessions/{uuid}.jsonl`:

- **Claude CLI** sessions from `~/.claude/projects/`
- **Pi** sessions from `~/.pi/agent/sessions/` (tree-structured JSONL with parentId chains)
- **Codex** sessions from `~/.codex/sessions/`

The frontend connects via SSE for real-time updates. Terminal sessions run in tmux and stream via xterm.js.

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
