---
name: feather
description: Manage a running Feather Claude session viewer — health, logs, quick links, deploy. Use when the user says /feather.
---

# /feather — server ops

Set `PORT` to your feather port (4870 by default). All `curl` examples below use `localhost:$PORT`:

```bash
export PORT=4870   # change to match your install
```

## Install

Symlink this directory into your Claude skills dir, then restart Claude Code:

```bash
ln -sf "$(pwd)/skills/feather" ~/.claude/skills/feather
```

(Run from the feather repo root.)

## Health

```bash
curl -sf localhost:$PORT/api/health | python3 -m json.tool
```

Non-200 → server is down. Returns `{version, ...}`.

## Logs

Depends on how feather is running:

| Runtime | Tail logs |
|---------|-----------|
| supervisord (`infra/feather.supervisor.conf`) | `supervisorctl tail -f feather stdout` |
| systemd (`infra/feather.service`) | `journalctl -u feather -f` |
| foreground `npm start` | look at the terminal |

## Restart

| Runtime | Command |
|---------|---------|
| supervisord | `supervisorctl restart feather` |
| systemd | `systemctl restart feather` |
| foreground | `Ctrl-C` then `npm start` |

## Deploy

```bash
cd path/to/feather
npm run deploy
```

`npm run deploy` stamps `version.json`, rebuilds the frontend, then runs `supervisorctl restart feather`. If you don't use supervisord, run `npm run build` and restart however you usually do.

After deploy, both `/api/health` and the frontend tab bar should show the same fresh version timestamp.

## Quick links

The "Links" tab in the sidebar reads `quick-links.json`.

```bash
# List
curl -s localhost:$PORT/api/quick-links | python3 -m json.tool

# Add
links=$(curl -s localhost:$PORT/api/quick-links)
curl -s -X POST localhost:$PORT/api/quick-links \
  -H "Content-Type: application/json" \
  -d "$(echo "$links" | python3 -c "import sys,json; l=json.load(sys.stdin); l.append({'label':'LABEL','url':'URL'}); print(json.dumps(l))")"

# Remove
links=$(curl -s localhost:$PORT/api/quick-links)
curl -s -X POST localhost:$PORT/api/quick-links \
  -H "Content-Type: application/json" \
  -d "$(echo "$links" | python3 -c "import sys,json; l=json.load(sys.stdin); l=[x for x in l if x['label']!='LABEL']; print(json.dumps(l))")"
```

## Projects

The "Projects" section in the sidebar reads `project-labels.json`. It's an
allowlist: a project shows up only if its Claude-encoded directory name is a
key in this file. The value is the display label (or `null` to use the
auto-derived basename). Use ` / ` in the label to make a two-level group, e.g.
`"crypto / hft"` puts it under a "crypto" group.

A project ID is the directory name under `~/.claude/projects/`, which Claude
encodes from your cwd by replacing `/` with `-`. So `/home/user/feather`
becomes `-home-user-feather`. Encode helper:

```bash
encode_project_id() { echo "$(realpath "${1:-$PWD}")" | sed 's|/|-|g'; }
```

```bash
# List
curl -s localhost:$PORT/api/projects | python3 -m json.tool

# Add current dir (auto label)
id=$(encode_project_id)
curl -s -X POST "localhost:$PORT/api/projects/$id/label" \
  -H "Content-Type: application/json" -d '{"label":null}'

# Add a path with custom label
id=$(encode_project_id ~/life/taxes)
curl -s -X POST "localhost:$PORT/api/projects/$id/label" \
  -H "Content-Type: application/json" -d '{"label":"life / taxes"}'

# Remove
id=$(encode_project_id ~/old-experiment)
curl -s -X DELETE "localhost:$PORT/api/projects/$id"
```

## Sub-commands

| Command | What it does |
|---------|--------------|
| `/feather` or `/feather status` | Hit `/api/health` |
| `/feather logs` | Tail logs (best-effort detect supervisord/systemd) |
| `/feather restart` | Restart the server |
| `/feather deploy` | `cd <repo> && npm run deploy` |
| `/feather links` | List quick links |
| `/feather add link LABEL URL` | Append a quick link |
| `/feather remove link LABEL` | Remove a quick link by label |
| `/feather projects` | List projects in the allowlist |
| `/feather add project [PATH] [--label LABEL]` | Add to allowlist (default PATH = `pwd`) |
| `/feather remove project [PATH]` | Remove from allowlist (default PATH = `pwd`) |
