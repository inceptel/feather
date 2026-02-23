#!/bin/bash
# Safe deploy: build → canary (through Caddy) → test → swap binary → restart
# This is the primary way to ship changes.
set -e
cd "$(dirname "$0")/.."

FEATHER_BIN="/usr/local/bin/feather"
FEATHER_PREV="/usr/local/bin/feather.previous"
BUILDS_DIR="/usr/local/bin/feather-builds"
CANARY_PORT=4851
CANARY_CADDY_PORT=8081
PROD_PORT=4850

echo "=== Deploy ==="

# Step 1: Build
echo ""
echo "[1/4] Building..."
./tools/build.sh

# Step 2: Start canary on alternate port, fronted by Caddy
echo ""
echo "[2/4] Starting canary on :$CANARY_PORT (Caddy :$CANARY_CADDY_PORT)..."

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

# Wait for canary backend to be healthy
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
echo "  Canary backend healthy (PID $CANARY_PID)"

# Add canary server to Caddy (mirrors production routing, points to canary backend)
CANARY_CADDY_CONFIG=$(cat <<CADDYJSON
{
  "listen": [":$CANARY_CADDY_PORT"],
  "routes": [
    {
      "match": [{"path": ["/jupyter/*"]}],
      "handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": "localhost:8888"}]}]
    },
    {
      "match": [{"path": ["/terminal/*", "/terminal"]}],
      "handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": "localhost:7681"}], "flush_interval": -1}]
    },
    {
      "handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": "localhost:$CANARY_PORT"}]}]
    }
  ]
}
CADDYJSON
)

CADDY_ADDED=false
if curl -sf -X POST "http://localhost:2019/config/apps/http/servers/canary" \
    -H "Content-Type: application/json" \
    -d "$CANARY_CADDY_CONFIG" > /dev/null 2>&1; then
    CADDY_ADDED=true
    echo "  Caddy canary route added on :$CANARY_CADDY_PORT"

    # Wait for Caddy canary to be reachable
    for i in $(seq 1 10); do
        sleep 0.5
        if curl -sf "http://localhost:$CANARY_CADDY_PORT/health" > /dev/null 2>&1; then
            break
        fi
    done
else
    echo "  WARNING: Could not add Caddy canary route, testing directly on :$CANARY_PORT"
fi

# Choose test URL (prefer Caddy-fronted canary)
if [ "$CADDY_ADDED" = "true" ]; then
    TEST_URL="http://localhost:$CANARY_CADDY_PORT"
else
    TEST_URL="http://localhost:$CANARY_PORT"
fi

# Step 3: Run tests against canary
echo ""
echo "[3/4] Testing canary ($TEST_URL)..."
TEST_PASSED=false

if [ -d node_modules ] && command -v npx > /dev/null 2>&1; then
    if FEATHER_URL="$TEST_URL" npx playwright test tests/e2e.spec.js --reporter=line 2>&1; then
        TEST_PASSED=true
    fi
else
    echo "  (no test deps installed — skipping, using health check only)"
    TEST_PASSED=true
fi

# Clean up: remove Caddy canary route and kill canary
if [ "$CADDY_ADDED" = "true" ]; then
    curl -sf -X DELETE "http://localhost:2019/config/apps/http/servers/canary" > /dev/null 2>&1
    echo "  Caddy canary route removed"
fi
kill $CANARY_PID 2>/dev/null
wait $CANARY_PID 2>/dev/null || true

if [ "$TEST_PASSED" != "true" ]; then
    echo ""
    echo "FAIL: Tests failed against canary. Not deploying."
    echo "  Production is unchanged. Fix the issue and try again."
    exit 1
fi

# Step 4: Swap binary, archive build, and restart
echo ""
echo "[4/4] Deploying..."

# Ensure builds directory exists
sudo mkdir -p "$BUILDS_DIR"

# Read version from build
VERSION=$(cat target/BUILD_VERSION 2>/dev/null || TZ=America/New_York date +%Y%m%d-%H%M)

# One-time migration: import feather.previous as a build if it exists
if [ -f "$FEATHER_PREV" ] && [ "$(find "$BUILDS_DIR" -maxdepth 1 -name '*.bin' 2>/dev/null | wc -l)" -eq 0 ]; then
    PREV_VERSION="pre-versioned"
    sudo cp "$FEATHER_PREV" "$BUILDS_DIR/${PREV_VERSION}.bin"
    echo "  Migrated feather.previous as build '${PREV_VERSION}'"
fi

# Save previous binary for rollback (dereference symlinks)
if [ -f "$FEATHER_BIN" ]; then
    sudo cp -L "$FEATHER_BIN" "$FEATHER_PREV"
fi

# Archive this build (binary + static assets)
sudo cp target/release/feather-rs "$BUILDS_DIR/${VERSION}.bin"
sudo tar cf "$BUILDS_DIR/${VERSION}.static.tar" -C "$(pwd)" static/

# Install new binary (remove symlink first if present)
if [ -L "$FEATHER_BIN" ]; then
    sudo rm "$FEATHER_BIN"
fi
sudo cp "$BUILDS_DIR/${VERSION}.bin" "$FEATHER_BIN"

# Sync static assets to production (remove symlinks first to avoid self-copy)
find /opt/feather/static/ -maxdepth 1 -type l -delete 2>/dev/null || true
cp -f static/* /opt/feather/static/

# Record active version
echo "$VERSION" | sudo tee "$BUILDS_DIR/active" > /dev/null

# Cleanup: keep newest 20 builds
BUILD_COUNT=$(find "$BUILDS_DIR" -maxdepth 1 -name '*.bin' | wc -l)
if [ "$BUILD_COUNT" -gt 20 ]; then
    find "$BUILDS_DIR" -maxdepth 1 -name '*.bin' -printf '%T@ %p\n' | sort -rn | tail -n +21 | cut -d' ' -f2 | while read f; do
        sudo rm -f "$f" "${f%.bin}.static.tar"
    done
    echo "  Cleaned old builds (kept newest 20)"
fi

# Restart via supervisord (clean env, no CLAUDECODE leakage)
sudo supervisorctl -s unix:///tmp/supervisor.sock restart feather

# Verify production is healthy
sleep 2
if curl -sf "http://localhost:$PROD_PORT/health" > /dev/null 2>&1; then
    HEALTH_VERSION=$(curl -sf "http://localhost:$PROD_PORT/health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo "?")
    echo ""
    echo "=== Deployed successfully (v$HEALTH_VERSION, build $VERSION) ==="
    echo "  $BUILD_COUNT build(s) archived in $BUILDS_DIR"
    echo "  Rollback: ./tools/rollback.sh"
    echo "  Admin:    http://localhost:8080/admin"
else
    echo ""
    echo "WARNING: Production not healthy after restart!"
    echo "  Run ./tools/rollback.sh to revert"
    exit 1
fi
