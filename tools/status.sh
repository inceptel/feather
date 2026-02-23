#!/bin/bash
# Show current version, health, git status, running services
cd "$(dirname "$0")/.."

echo "=== Feather Status ==="
echo ""

# Git info
echo "Commit:  $(git log --oneline -1)"
echo "Branch:  $(git branch --show-current)"

# Local changes
CHANGES=$(git status --porcelain)
if [ -z "$CHANGES" ]; then
    echo "Tree:    clean"
else
    echo "Tree:    dirty"
    echo "$CHANGES" | sed 's/^/         /'
fi

# Health
echo ""
HEALTH=$(curl -sf http://localhost:4850/health 2>/dev/null)
if [ -n "$HEALTH" ]; then
    UPTIME=$(echo "$HEALTH" | python3 -c "import sys,json; s=json.load(sys.stdin).get('uptime_secs',0); print(f'{s//3600}h {(s%3600)//60}m')" 2>/dev/null || echo "?")
    TMUX_COUNT=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('active_tmux_sessions',0))" 2>/dev/null || echo "?")
    echo "Health:  OK (up $UPTIME, $TMUX_COUNT tmux sessions)"
else
    echo "Health:  DOWN"
fi

# Rollback available?
if [ -f /usr/local/bin/feather.previous ]; then
    echo "Rollback: available"
else
    echo "Rollback: no previous binary"
fi

# Services
echo ""
echo "Services:"
sudo supervisorctl status 2>/dev/null | sed 's/^/  /' || echo "  supervisord not running"
