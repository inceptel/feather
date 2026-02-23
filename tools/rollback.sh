#!/bin/bash
# Instant rollback: swap to previous binary and restart.
# No rebuild needed — takes <2 seconds.
set -e

FEATHER_BIN="/usr/local/bin/feather"
FEATHER_PREV="/usr/local/bin/feather.previous"

echo "=== Rollback ==="

if [ ! -f "$FEATHER_PREV" ]; then
    echo "ERROR: No previous binary found at $FEATHER_PREV"
    echo "  (rollback is only available after at least one deploy.sh run)"
    exit 1
fi

# Swap: current → broken, previous → current
echo "Swapping binaries..."
cp -L "$FEATHER_BIN" "${FEATHER_BIN}.broken" 2>/dev/null || true
if [ -L "$FEATHER_BIN" ]; then
    sudo rm "$FEATHER_BIN"
fi
sudo cp "$FEATHER_PREV" "$FEATHER_BIN"

# Restart
echo "Restarting..."
sudo supervisorctl restart feather

sleep 2
if curl -sf "http://localhost:4850/health" > /dev/null 2>&1; then
    echo ""
    echo "=== Rolled back successfully ==="
    echo "  Broken binary saved at: ${FEATHER_BIN}.broken"
else
    echo ""
    echo "WARNING: Feather not healthy after rollback!"
fi
