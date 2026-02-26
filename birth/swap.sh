#!/bin/bash
set -euo pipefail

WORK_IMAGE="${1:-${WORK_IMAGE:-localhost/feather-work:latest}}"
WORK_IMAGE_TAR="${WORK_IMAGE_TAR:-/opt/feather-work.tar}"
STATE_CONTAINER="/tmp/active-work-container"
STATE_PORT="/tmp/active-work-port"
HEALTH_TIMEOUT=120
DRAIN_SECONDS=5

log() { echo "[swap] $(date '+%H:%M:%S') $*"; }

# --- 1. Load new image if tar was updated ---
if [ -f "$WORK_IMAGE_TAR" ]; then
    log "Loading work image from $WORK_IMAGE_TAR..."
    podman load -i "$WORK_IMAGE_TAR"
    log "Image loaded"
fi

# --- 2. Read current state ---
CURRENT_NAME=$(cat "$STATE_CONTAINER" 2>/dev/null || echo "")
CURRENT_PORT=$(cat "$STATE_PORT" 2>/dev/null || echo "")

if [ -z "$CURRENT_NAME" ] || [ -z "$CURRENT_PORT" ]; then
    log "ERROR: No active work container found"
    exit 1
fi

log "Current: $CURRENT_NAME on port $CURRENT_PORT"

# --- 3. Determine new name and port ---
if [ "$CURRENT_NAME" = "feather-work-blue" ]; then
    NEW_NAME="feather-work-green"
    NEW_PORT=8081
else
    NEW_NAME="feather-work-blue"
    NEW_PORT=8080
fi

log "New: $NEW_NAME on port $NEW_PORT"

# --- 4. Clean up any stale container with the new name ---
if podman container exists "$NEW_NAME" 2>/dev/null; then
    log "Removing stale container: $NEW_NAME"
    podman stop -t 5 "$NEW_NAME" 2>/dev/null || true
    podman rm -f "$NEW_NAME" 2>/dev/null || true
fi

# --- 5. Start new container ---
log "Starting $NEW_NAME..."

env_args=()
while IFS='=' read -r key value; do
    case "$key" in
        FEATHER_*|ANTHROPIC_*|OPENAI_*)
            env_args+=(-e "${key}=${value}")
            ;;
    esac
done < <(env)

podman run -d \
    --name "$NEW_NAME" \
    -p "127.0.0.1:${NEW_PORT}:8080" \
    -v /home/user:/home/user:Z \
    "${env_args[@]}" \
    "$WORK_IMAGE"

# --- 6. Health check new container ---
log "Waiting for $NEW_NAME health check (timeout: ${HEALTH_TIMEOUT}s)..."
healthy=false
for i in $(seq 1 "$HEALTH_TIMEOUT"); do
    if curl -sf "http://127.0.0.1:${NEW_PORT}/health" > /dev/null 2>&1; then
        healthy=true
        break
    fi
    sleep 1
done

if [ "$healthy" != "true" ]; then
    log "ERROR: New container failed health check — aborting swap"
    log "Old container ($CURRENT_NAME) remains active"
    podman logs "$NEW_NAME" 2>&1 | tail -30
    podman stop -t 5 "$NEW_NAME" 2>/dev/null || true
    podman rm -f "$NEW_NAME" 2>/dev/null || true
    exit 1
fi

log "New container healthy"

# --- 7. Switch Caddy upstream (atomic) ---
log "Switching Caddy upstream to 127.0.0.1:$NEW_PORT..."
PATCH_RESPONSE=$(curl -sf -X PATCH \
    -H "Content-Type: application/json" \
    -d "[{\"dial\": \"127.0.0.1:${NEW_PORT}\"}]" \
    "http://localhost:2019/id/work_upstream/upstreams" 2>&1) || {
    log "ERROR: Caddy PATCH failed: $PATCH_RESPONSE"
    log "Aborting — old container remains active, new container will be removed"
    podman stop -t 5 "$NEW_NAME" 2>/dev/null || true
    podman rm -f "$NEW_NAME" 2>/dev/null || true
    exit 1
}

log "Caddy upstream switched"

# --- 8. Drain old container ---
log "Draining old container ($CURRENT_NAME) for ${DRAIN_SECONDS}s..."
sleep "$DRAIN_SECONDS"

# --- 9. Stop and remove old container ---
log "Stopping $CURRENT_NAME..."
podman stop -t 10 "$CURRENT_NAME" 2>/dev/null || true
podman rm -f "$CURRENT_NAME" 2>/dev/null || true

# --- 10. Update state ---
echo "$NEW_NAME" > "$STATE_CONTAINER"
echo "$NEW_PORT" > "$STATE_PORT"

log "Swap complete: $CURRENT_NAME -> $NEW_NAME"
log "Active: $NEW_NAME on port $NEW_PORT"
