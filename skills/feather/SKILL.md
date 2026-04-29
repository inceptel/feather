---
name: feather
description: Manage the Feather Claude session viewer — check service status, view logs, manage autoweb workers, quick links, and promote staging to prod. Node.js + Express + SolidJS on allan.feather-cloud.dev.
metadata:
  author: Allan Maymin
  version: "3.0"
---

# Feather — Claude Session Viewer

## Architecture

```
~/feather/              — prod git repo (main branch), port 3300
~/feather-dev/w1..w6    — git worktrees for autoweb workers
~/feather-aw/w1..w6     — autoweb worker state directories

Stack: Node.js + Express + SolidJS (Vite build → static/)
Supervisor socket: unix:///tmp/supervisor.sock
```

## Supervisor Programs

| Program | Directory | Port | Role |
|---------|-----------|------|------|
| feather | ~/feather | 3300 | PROD — never touch |
| feather-dev | ~/feather-dev/w1 | 3301 | Staging / Team Claude integration |
| feather-w2 | ~/feather-dev/w2 | 3302 | Worker 2 |
| feather-w3 | ~/feather-dev/w3 | 3303 | Worker 3 |
| feather-w4 | ~/feather-dev/w4 | 3304 | Worker 4 |
| feather-w5 | ~/feather-dev/w5 | 3305 | Worker 5 |
| feather-w6 | ~/feather-dev/w6 | 3306 | Worker 6 |

## Autoweb Workers

| Program | Worktree | Role |
|---------|----------|------|
| autoweb-feather | w1 | Claude Finder |
| autoweb-feather-2 | w2 | Claude Replicator |
| autoweb-feather-3 | w3 | Claude Fixer |
| autoweb-feather-4 | w4 | Codex Finder |
| autoweb-feather-5 | w5 | Codex Replicator |
| autoweb-feather-6 | w6 | Codex Fixer |

## Caddy Routes (allan.feather-cloud.dev)

| Path | Backend | What |
|------|---------|------|
| / | port 3300 | Prod |
| /staging/ | port 3301 | Team Claude |
| /staging-codex/ | port 3304 | Team Codex |
| /autoweb/ | port 8096 | Dashboard |

## Check Status

```bash
supervisorctl -s unix:///tmp/supervisor.sock status

# Health checks
for port in 3300 3301 3302 3303 3304 3305 3306; do
  echo "Port $port: $(curl -sf localhost:$port/health && echo OK || echo DOWN)"
done
```

## View Logs

```bash
# Prod logs
supervisorctl -s unix:///tmp/supervisor.sock tail feather stdout

# Staging logs
supervisorctl -s unix:///tmp/supervisor.sock tail feather-dev stdout

# Any worker
supervisorctl -s unix:///tmp/supervisor.sock tail feather-w2 stdout
```

## Restart Services

```bash
# Restart prod (careful!)
supervisorctl -s unix:///tmp/supervisor.sock restart feather

# Restart staging
supervisorctl -s unix:///tmp/supervisor.sock restart feather-dev

# Restart a worker
supervisorctl -s unix:///tmp/supervisor.sock restart feather-w3
```

## Promote Staging to Prod

```bash
cd ~/feather && git merge dev-w1 && npm run build:frontend
```

## Quick Links

Quick links are stored in `~/feather/quick-links.json`. The frontend has a "Links" tab in the sidebar.

- `GET /api/quick-links` — returns the array
- `POST /api/quick-links` — replaces the array (body: JSON array of `{label, url}`)

**Default quick links:**
- Prod → `/`
- Staging (Claude) → `/staging/`
- Staging (Codex) → `/staging-codex/`
- Autoweb Dashboard → `/autoweb/`
- AgentsView → `/av/`

**View current links:**
```bash
curl -s http://localhost:3300/api/quick-links | python3 -m json.tool
```

**Add a quick link:**
```bash
links=$(curl -s http://localhost:3300/api/quick-links)
curl -s -X POST http://localhost:3300/api/quick-links \
  -H "Content-Type: application/json" \
  -d "$(echo "$links" | python3 -c "import sys,json; links=json.load(sys.stdin); links.append({'label':'LABEL','url':'URL'}); print(json.dumps(links))")"
```

**Remove a quick link:**
```bash
links=$(curl -s http://localhost:3300/api/quick-links)
curl -s -X POST http://localhost:3300/api/quick-links \
  -H "Content-Type: application/json" \
  -d "$(echo "$links" | python3 -c "import sys,json; links=json.load(sys.stdin); links=[l for l in links if l['label']!='LABEL']; print(json.dumps(links))")"
```

## Autoweb Worker Management

```bash
# Check worker status
cat ~/feather-aw/w*/current.txt

# Start/stop via supervisorctl
supervisorctl -s unix:///tmp/supervisor.sock start autoweb-feather
supervisorctl -s unix:///tmp/supervisor.sock stop autoweb-feather

# Start all Claude workers (w1-w3)
supervisorctl -s unix:///tmp/supervisor.sock start autoweb-feather autoweb-feather-2 autoweb-feather-3

# Start all Codex workers (w4-w6)
supervisorctl -s unix:///tmp/supervisor.sock start autoweb-feather-4 autoweb-feather-5 autoweb-feather-6

# Stop all
supervisorctl -s unix:///tmp/supervisor.sock stop autoweb-feather autoweb-feather-2 autoweb-feather-3 autoweb-feather-4 autoweb-feather-5 autoweb-feather-6
```

## Key File Locations

| Path | What |
|------|------|
| `~/feather/` | Prod git repo (main branch) |
| `~/feather-dev/w1..w6` | Git worktrees for workers |
| `~/feather-aw/w1..w6` | Autoweb worker state dirs |
| `~/feather/static/` | Prod static files (Vite output) |
| `~/feather/quick-links.json` | Quick links data |

## Sub-Commands

| Command | What it does |
|---------|-------------|
| `/feather` | Show these docs |
| `/feather status` | Run supervisorctl status for all feather services + health checks on ports 3300-3306 |
| `/feather logs [service]` | Tail logs (default: feather) |
| `/feather add link LABEL URL` | Add a quick link to ~/feather/quick-links.json |
| `/feather remove link LABEL` | Remove a quick link by label |
| `/feather links` | List all quick links |
| `/feather workers` | Show autoweb worker status (from ~/feather-aw/w*/current.txt) |
| `/feather start [all|claude|codex|wN]` | Start autoweb workers |
| `/feather stop [all|claude|codex|wN]` | Stop autoweb workers |
| `/feather promote` | Copy staging (w1) changes to prod: cd ~/feather && git merge dev-w1 && npm run build:frontend |
