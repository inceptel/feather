---
name: auto
description: Manage autoweb autonomous improvement instances via Feather's /api/auto endpoints. Use when user says /auto, asks about autoweb, or wants to start/stop/inspect a self-improving loop. Each instance lives in ~/autoweb-NAME/ with run.sh + program.md + results.tsv.
---

# /auto — autoweb control

## Install

Symlink this directory into your Claude skills dir, then restart Claude Code:

```bash
ln -sf "$(pwd)/skills/auto" ~/.claude/skills/auto
```

(Run from the feather repo root.) The skill talks to a running Feather server's `/api/auto/*` endpoints.

All commands hit `localhost:3310/api/auto/*` (Feather dev). For prod, swap to 3300.

## Commands

### `/auto status` (or `/auto`)

```bash
curl -s localhost:3310/api/auto/instances | python3 -c "
import json, sys
for i in json.load(sys.stdin)['instances']:
    flag = '●' if i['running'] else '○'
    print(f\"{flag} {i['name']:20} k={i['keeps']:3} r={i['reverts']:2} c={i['crashes']:2} — {i['current'][:80]}\")
"
```

### `/auto new <name> [args]`

Two templates:

**simple** (claude-only, ~30s/iter — for quick goals like "what is 1+1"):
```bash
curl -s -X POST localhost:3310/api/auto/instances \
  -H "Content-Type: application/json" \
  -d '{"name":"NAME","template":"simple","goal":"GOAL TEXT"}'
```

**full** (default, 6-phase claude+codex pipeline — for real codebases):
```bash
curl -s -X POST localhost:3310/api/auto/instances \
  -H "Content-Type: application/json" \
  -d '{"name":"NAME","target":"/path/to/file","url":"https://...","repo":"/path/to/repo"}'
```

After create, edit `~/autoweb-NAME/program.md` to flesh out CAN/CANNOT/verify, then start.

### `/auto start <name>` / `/auto stop <name>`

```bash
curl -s -X POST localhost:3310/api/auto/instances/NAME/start
curl -s -X POST localhost:3310/api/auto/instances/NAME/stop
```

### `/auto focus <name> <text>`

Replace (or append) `## CURRENT FOCUS` section in program.md.
```bash
curl -s -X POST localhost:3310/api/auto/instances/NAME/focus \
  -H "Content-Type: application/json" -d '{"focus":"TEXT"}'
```

### `/auto btw <name> <note>`

Append a timestamped note to `## Known issues` (worker picks up next iteration).
```bash
curl -s -X POST localhost:3310/api/auto/instances/NAME/btw \
  -H "Content-Type: application/json" -d '{"note":"TEXT"}'
```

### `/auto link <name> <sessionId>`

Bind a Feather chat session as the "main chat" for this instance (steering wheel).
```bash
curl -s -X POST localhost:3310/api/auto/instances/NAME/link \
  -H "Content-Type: application/json" -d '{"sessionId":"SID"}'
```

### `/auto show <name>`

```bash
curl -s localhost:3310/api/auto/instances/NAME | python3 -m json.tool
```

### `/auto tail <name>`

```bash
tail -f ~/autoweb-NAME/auto.log    # supervisor stdout
ls -t ~/autoweb-NAME/logs/ | head -3  # per-iteration claude/codex output
```

### `/auto deploy <name>`

Instance-specific. For feather: merge dev branch + npm deploy. Read `~/autoweb-NAME/deploy.sh` if present, else ask user.

## Files per instance

| Path | Purpose |
|------|---------|
| `~/autoweb-NAME/run.sh` | Loop harness |
| `~/autoweb-NAME/program.md` | Goal + focus + bugs + constraints |
| `~/autoweb-NAME/results.tsv` | timestamp \t status \t description |
| `~/autoweb-NAME/current.txt` | One-line live status |
| `~/autoweb-NAME/auto.pid` | Running pid (used by /api/auto) |
| `~/autoweb-NAME/auto.log` | Stdout from harness |
| `~/autoweb-NAME/logs/` | Per-iteration claude/codex output |
| `~/autoweb-NAME/main_chat.txt` | Bound Feather session id (optional) |
| `~/autoweb-NAME/deadline` | Epoch deadline for current iter |

## Notes

- Names: lowercase alphanumeric + dashes, max 30 chars.
- The full template currently inherits codex `-C` working dir from the `repo` field; pass any existing dir if you don't have a real repo.
- `simple` template is claude-only, 10-min timeout, no codex calls. Use for harness tests or trivial goals.
- Old skill at `~/.claude/skills/autoweb/` superseded by this. Backups at `~/.backups/autoweb-skill-*.tar.gz`.
