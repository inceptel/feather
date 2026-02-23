#!/bin/bash
# Safe deploy: build → canary test → swap binary → restart
# This is the primary way to ship changes.
set -e
cd "$(dirname "$0")/.."

FEATHER_BIN="/usr/local/bin/feather"
FEATHER_PREV="/usr/local/bin/feather.previous"
CANARY_PORT=4851
PROD_PORT=4850

echo "=== Deploy ==="

# Step 1: Build
echo ""
echo "[1/4] Building..."
./tools/build.sh

# Step 2: Start canary on alternate port
echo ""
echo "[2/4] Starting canary on :$CANARY_PORT..."

# Clean env: strip CLAUDECODE vars that break Claude CLI spawning
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
    PORT=$CANARY_PORT \
    HOME=/home/user \
    FEATHER_UPLOAD_DIR=/opt/feather/uploads \
    bash -c '
        if [ -f /home/user/.env ]; then set -a; . /home/user/.env; set +a; fi
        exec ./target/release/feather-rs
    ' &
CANARY_PID=$!

# Wait for canary to be healthy
HEALTHY=false
for i in $(seq 1 20); do
    sleep 1
    if curl -sf "http://localhost:$CANARY_PORT/health" > /dev/null 2>&1; then
        HEALTHY=true
        break
    fi
done

if [ "$HEALTHY" != "true" ]; then
    echo "FAIL: Canary never became healthy"
    kill $CANARY_PID 2>/dev/null
    wait $CANARY_PID 2>/dev/null
    exit 1
fi
echo "  Canary healthy (PID $CANARY_PID)"

# Step 3: Run tests against canary
echo ""
echo "[3/4] Testing canary..."
TEST_PASSED=false

if [ -d node_modules ] && command -v npx > /dev/null 2>&1; then
    if FEATHER_URL="http://localhost:$CANARY_PORT" npx playwright test tests/e2e.spec.js --reporter=line 2>&1; then
        TEST_PASSED=true
    fi
else
    echo "  (no test deps installed — skipping, using health check only)"
    TEST_PASSED=true
fi

# Kill canary regardless
kill $CANARY_PID 2>/dev/null
wait $CANARY_PID 2>/dev/null

if [ "$TEST_PASSED" != "true" ]; then
    echo ""
    echo "FAIL: Tests failed against canary. Not deploying."
    echo "  Production is unchanged. Fix the issue and try again."
    exit 1
fi

# Step 4: Swap binary and restart
echo ""
echo "[4/4] Deploying..."

# Save previous binary for rollback (dereference symlinks)
if [ -f "$FEATHER_BIN" ]; then
    cp -L "$FEATHER_BIN" "$FEATHER_PREV"
fi

# Install new binary (remove symlink first if present)
if [ -L "$FEATHER_BIN" ]; then
    sudo rm "$FEATHER_BIN"
fi
sudo cp target/release/feather-rs "$FEATHER_BIN"

# Restart via supervisord (clean env, no CLAUDECODE leakage)
sudo supervisorctl restart feather

# Verify production is healthy
sleep 2
if curl -sf "http://localhost:$PROD_PORT/health" > /dev/null 2>&1; then
    VERSION=$(curl -sf "http://localhost:$PROD_PORT/health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "?")
    echo ""
    echo "=== Deployed successfully (v$VERSION) ==="
    echo "  Rollback: ./tools/rollback.sh"
else
    echo ""
    echo "WARNING: Production not healthy after restart!"
    echo "  Run ./tools/rollback.sh to revert"
    exit 1
fi
