#!/bin/bash
# Show current version, git status, running services
cd /opt/feather

echo "=== Feather Status ==="
echo ""
echo "Version: $(git log --oneline -1)"
echo "Branch:  $(git branch --show-current)"
echo ""

# Local changes
CHANGES=$(git status --porcelain)
if [ -z "$CHANGES" ]; then
    echo "Clean (no local changes)"
else
    echo "Local changes:"
    echo "$CHANGES"
fi

echo ""
echo "Services:"
sudo supervisorctl status 2>/dev/null || echo "  supervisord not running"
