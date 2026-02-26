#!/bin/bash
# Rollback: promote a previous build and restart.
# Usage: ./tools/rollback.sh [VERSION]
#   With VERSION: promote that specific build
#   Without:      promote the second-newest build
set -e

FEATHER_BIN="/usr/local/bin/feather"
FEATHER_PREV="/usr/local/bin/feather.previous"
BUILDS_DIR="/usr/local/bin/feather-builds"

echo "=== Rollback ==="

# If builds dir exists, use versioned rollback
if [ -d "$BUILDS_DIR" ] && [ "$(ls "$BUILDS_DIR"/*.bin 2>/dev/null | wc -l)" -gt 0 ]; then
    ACTIVE=$(cat "$BUILDS_DIR/active" 2>/dev/null || echo "")

    if [ -n "$1" ]; then
        # Explicit version requested
        TARGET="$1"
        if [ ! -f "$BUILDS_DIR/${TARGET}.bin" ]; then
            echo "ERROR: Build '$TARGET' not found."
            echo ""
            echo "Available builds:"
            ls -1t "$BUILDS_DIR"/*.bin 2>/dev/null | while read f; do
                V=$(basename "$f" .bin)
                if [ "$V" = "$ACTIVE" ]; then
                    echo "  $V  [ACTIVE]"
                else
                    echo "  $V"
                fi
            done
            exit 1
        fi
    else
        # No version specified: pick the second-newest build
        TARGET=$(ls -1t "$BUILDS_DIR"/*.bin | head -2 | tail -1 | xargs basename | sed 's/\.bin$//')
        if [ "$TARGET" = "$ACTIVE" ] || [ -z "$TARGET" ]; then
            echo "ERROR: No previous build to roll back to."
            echo ""
            echo "Available builds:"
            ls -1t "$BUILDS_DIR"/*.bin 2>/dev/null | while read f; do
                V=$(basename "$f" .bin)
                if [ "$V" = "$ACTIVE" ]; then
                    echo "  $V  [ACTIVE]"
                else
                    echo "  $V"
                fi
            done
            exit 1
        fi
    fi

    echo "Promoting build: $TARGET (was: $ACTIVE)"

    # Restore static assets if archived
    if [ -f "$BUILDS_DIR/${TARGET}.static.tar" ]; then
        tar xf "$BUILDS_DIR/${TARGET}.static.tar" -C /opt/feather/
        echo "  Restored static assets"
    fi

    # Swap binary (rm + cp avoids "Text file busy", then pkill — supervisord auto-restarts)
    sudo rm -f "$FEATHER_BIN"
    sudo cp "$BUILDS_DIR/${TARGET}.bin" "$FEATHER_BIN"
    echo "$TARGET" | sudo tee "$BUILDS_DIR/active" > /dev/null
    pkill -x feather || true

    # Wait for supervisord to restart feather
    echo "Restarting..."
    for i in $(seq 1 10); do
        sleep 2
        if curl -sf "http://localhost:4850/health" > /dev/null 2>&1; then
            echo ""
            echo "=== Rolled back to $TARGET ==="
            break
        fi
    done

# Legacy fallback: use feather.previous
elif [ -f "$FEATHER_PREV" ]; then
    echo "No versioned builds found. Using legacy feather.previous..."
    sudo cp -L "$FEATHER_BIN" "${FEATHER_BIN}.broken" 2>/dev/null || true

    sudo rm -f "$FEATHER_BIN"
    sudo cp "$FEATHER_PREV" "$FEATHER_BIN"
    pkill -x feather || true

    echo "Restarting..."
    for i in $(seq 1 10); do
        sleep 2
        if curl -sf "http://localhost:4850/health" > /dev/null 2>&1; then
            echo ""
            echo "=== Rolled back successfully (legacy) ==="
            break
        fi
    done

else
    echo "ERROR: No builds or previous binary found."
    echo "  (rollback is only available after at least one deploy.sh run)"
    exit 1
fi
