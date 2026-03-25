# Roadmap

## Next — Polish & Robustness

**Sidechain / isMeta passthrough**
- Currently filtered out in `parseMessage`. Change to: pass everything through with metadata flags
- Frontend gets a filter toggle: "Show thinking", "Show tool calls", "Show sidechain"
- Clean chat view = default filter preset, not data loss

**Tail-read for large sessions**
- `getMessages()` currently reads entire file → `split('\n')` → `slice(-limit)`
- Change to: `fs.open` + `fs.read` from `fileSize - estimatedBytes`, scan backward for N complete lines
- Target: <50ms for last 100 messages of a 1GB file

**Offset-based gap prevention**
- `GET /messages` returns `{messages, lastOffset}`
- `EventSource` opens with that offset as `Last-Event-ID`
- Server reads from offset → no gaps, no duplication

**Delivery receipts (WhatsApp-style)**
- ✓ = server received POST /send
- ✓✓ = message appears in JSONL (Claude CLI logged it)
- ✓✓ blue = assistant response begins
- Match sent messages by content + temporal proximity

## Later — Multi-Engine

**Engine adapter pattern**
```
Engine = {
  name: string
  spawn(id, cwd): void
  resume(id, cwd): void
  parseMessage(line): Message | null
  findSessionFile(id): string | null
}
```

Each engine is one file. The tmux wrapper, terminal WebSocket, and `sendInput` are engine-agnostic.

**Planned engines**
| Engine | Session format | Status |
|--------|---------------|--------|
| Claude Code | JSONL in `~/.claude/projects/` | Working |
| Codex | TBD | Research needed |
| OpenCode | TBD | Research needed |
| Gemini CLI | TBD | Research needed |
| Amp | TBD | Research needed |

## Later — Interactive Features

**AskUserQuestion support**
- Remove `--disallowed-tools AskUserQuestion`
- Frontend detects `tool_use` blocks with `name === 'AskUserQuestion'`
- Renders as a special "Claude is asking" bubble with input field
- Answer sends via existing `sendInput()` → tmux pipeline
- Auto-switch to chat tab when question arrives

**Permission prompts**
- Same pattern as AskUserQuestion
- "Claude wants to run X" → Allow/Deny buttons
- Allow = send "y\n", Deny = send "n\n"

**State machine (per session)**
```
'loading' | 'active' | 'waiting_input' | 'waiting_permission' | 'disconnected'
```
Replaces boolean signals. `isActive` becomes derived state.

## Later — Scale

**Index files**
- On first access, build `session.idx` — array of `[byteOffset, timestamp, uuid]`
- ~40 bytes per message = 4MB for 100k messages
- Enables instant random access, "jump to date", binary search

**Virtualized message list**
- `@tanstack/solid-virtual` for rendering only visible messages
- Required for sessions with 10k+ messages

**Progressive loading**
- Load newest 100 messages first
- Lazy-load older messages on scroll-up
- Never load entire session into memory

## npm publish plan

```json
{
  "name": "feather-cli",
  "bin": { "feather": "bin/feather.js" },
  "files": ["server.js", "static/", "bin/"],
  "optionalDependencies": { "node-pty": "^1.1.0" },
  "dependencies": { "express": "^5.1.0", "ws": "^8.20.0" }
}
```

`node-pty` is the hard part — native module requiring compilation. Make it optional so feather works without terminal; terminal lights up when node-pty is available.

## Notes from agentsview

[wesm/agentsview](https://github.com/wesm/agentsview) — MIT license, Go+Svelte, supports 12 agents. Read-only viewer.

**Worth adopting:**
1. Tool call grouping — consecutive tool-only messages collapsed into a compact group
2. Block type filtering — toggle visibility of thinking/tool/code blocks
3. Tool metadata extraction — show file paths, command snippets as compact tags
4. Transcript mode — "focused" view hides tool messages, shows only conversation
5. Virtualized scrolling — TanStack Virtual for huge sessions
6. Subagent inline expansion — click Agent tool call to see sub-conversation
7. DAG-aware fork detection — handle Claude's uuid/parentUuid branching

**Our advantages over agentsview:**
- Terminal integration (they don't have it)
- Live control (spawn, resume, send messages — they're read-only)
- No database (simpler, no sync lag)
- Same-language stack (JS everywhere)

agentsview is an **observer**. Feather is a **controller**.
