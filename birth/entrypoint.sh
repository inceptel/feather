#!/bin/bash
set -euo pipefail

CADDY_CONFIG="/opt/birth/caddy.json"
CADDY_RUNTIME="/tmp/caddy-runtime.json"
WORK_IMAGE="${WORK_IMAGE:-localhost/feather-work:latest}"
STATE_CONTAINER="/tmp/active-work-container"
STATE_PORT="/tmp/active-work-port"
HEALTH_TIMEOUT=120
WATCHDOG_INTERVAL=30
WATCHDOG_FAILURES=0
MAX_WATCHDOG_FAILURES=3

# Host podman socket (mounted in)
PODMAN_SOCKET="${PODMAN_SOCKET:-/run/podman/podman.sock}"
hostpodman() { podman --url "unix://$PODMAN_SOCKET" "$@"; }

log() { echo "[birth] $(date '+%H:%M:%S') $*"; }

# --- 1. Configure Caddy ---
log "Configuring Caddy..."
cp "$CADDY_CONFIG" "$CADDY_RUNTIME"

if [ -n "${DOMAIN:-}" ]; then
    log "Domain: $DOMAIN"
    jq --arg domain "$DOMAIN" '
        .apps.http.servers.main.listen = [":443"] |
        .apps.http.servers.main.routes[0].match = [{"host": [$domain]}]
    ' "$CADDY_RUNTIME" > /tmp/caddy-tmp.json && mv /tmp/caddy-tmp.json "$CADDY_RUNTIME"

    if [ -n "${ACME_EMAIL:-}" ]; then
        jq --arg email "$ACME_EMAIL" '
            .apps.tls.automation.policies[0].issuers[0].email = $email
        ' "$CADDY_RUNTIME" > /tmp/caddy-tmp.json && mv /tmp/caddy-tmp.json "$CADDY_RUNTIME"
    fi
else
    log "No DOMAIN set — HTTP-only mode on :80"
    jq '
        .apps.http.servers.main.listen = [":80"] |
        del(.apps.http.servers.http_redirect) |
        del(.apps.tls)
    ' "$CADDY_RUNTIME" > /tmp/caddy-tmp.json && mv /tmp/caddy-tmp.json "$CADDY_RUNTIME"
fi

# --- 2. Start Caddy ---
log "Starting Caddy..."
caddy run --config "$CADDY_RUNTIME" &
CADDY_PID=$!

for i in $(seq 1 30); do
    if curl -sf http://localhost:2019/config/ > /dev/null 2>&1; then
        log "Caddy admin API ready"
        break
    fi
    if [ "$i" -eq 30 ]; then
        log "ERROR: Caddy admin API not responding after 30s"
        exit 1
    fi
    sleep 1
done

# --- 3. Check host podman socket ---
if [ ! -S "$PODMAN_SOCKET" ]; then
    log "ERROR: Host podman socket not found at $PODMAN_SOCKET"
    log "Mount it with: -v /run/podman/podman.sock:/run/podman/podman.sock"
    exit 1
fi
log "Host podman socket: $PODMAN_SOCKET"

# --- 4. Find work image ---
log "Checking for work image: $WORK_IMAGE"
if ! hostpodman image exists "$WORK_IMAGE" 2>/dev/null; then
    log "Image not found, attempting build from source..."
    if [ -d /opt/feather-src ]; then
        hostpodman build -t "$WORK_IMAGE" -f /opt/feather-src/Containerfile /opt/feather-src/
    else
        log "ERROR: No image available and /opt/feather-src not mounted"
        exit 1
    fi
fi
log "Work image ready"

# --- 5. Start work container ---
start_work_container() {
    local name="$1"
    local port="$2"

    log "Starting work container: $name on port $port"

    # Collect env vars to pass through
    local env_args=()
    while IFS='=' read -r key value; do
        case "$key" in
            FEATHER_*|ANTHROPIC_*|OPENAI_*)
                env_args+=(-e "${key}=${value}")
                ;;
        esac
    done < <(env)

    hostpodman run -d \
        --name "$name" \
        -p "127.0.0.1:${port}:8080" \
        -v feather-home:/home/user:Z \
        "${env_args[@]}" \
        "$WORK_IMAGE"

    log "Container $name started"
}

# --- 6. Health check ---
wait_for_healthy() {
    local port="$1"
    local timeout="$2"

    log "Waiting for health on port $port (timeout: ${timeout}s)..."
    for i in $(seq 1 "$timeout"); do
        if curl -sf "http://127.0.0.1:${port}/health" > /dev/null 2>&1; then
            log "Health check passed on port $port"
            return 0
        fi
        sleep 1
    done
    log "ERROR: Health check timed out on port $port"
    return 1
}

# --- Initial launch ---
INITIAL_NAME="feather-work-blue"
INITIAL_PORT=8080

# Clean up any leftover work container from previous run
hostpodman stop -t 5 "$INITIAL_NAME" 2>/dev/null || true
hostpodman rm -f "$INITIAL_NAME" 2>/dev/null || true

start_work_container "$INITIAL_NAME" "$INITIAL_PORT"

if ! wait_for_healthy "$INITIAL_PORT" "$HEALTH_TIMEOUT"; then
    log "Work container failed health check, showing logs:"
    hostpodman logs "$INITIAL_NAME" 2>&1 | tail -50
    exit 1
fi

# --- 7. Record state ---
echo "$INITIAL_NAME" > "$STATE_CONTAINER"
echo "$INITIAL_PORT" > "$STATE_PORT"
log "Active: $INITIAL_NAME on port $INITIAL_PORT"

# --- 8. Signal handling ---
cleanup() {
    log "Shutting down..."
    local container
    container=$(cat "$STATE_CONTAINER" 2>/dev/null || true)
    if [ -n "$container" ]; then
        hostpodman stop -t 10 "$container" 2>/dev/null || true
        hostpodman rm -f "$container" 2>/dev/null || true
    fi
    kill "$CADDY_PID" 2>/dev/null || true
    log "Shutdown complete"
    exit 0
}
trap cleanup SIGTERM SIGINT

# --- 9. Watchdog loop ---
log "Watchdog started (interval: ${WATCHDOG_INTERVAL}s)"
while true; do
    sleep "$WATCHDOG_INTERVAL"

    # Check Caddy
    if ! kill -0 "$CADDY_PID" 2>/dev/null; then
        log "WARN: Caddy died, restarting..."
        caddy run --config "$CADDY_RUNTIME" &
        CADDY_PID=$!
        sleep 2
    fi

    # Check work container
    local_port=$(cat "$STATE_PORT" 2>/dev/null || echo "8080")
    if curl -sf "http://127.0.0.1:${local_port}/health" > /dev/null 2>&1; then
        WATCHDOG_FAILURES=0
    else
        WATCHDOG_FAILURES=$((WATCHDOG_FAILURES + 1))
        log "WARN: Health check failed ($WATCHDOG_FAILURES/$MAX_WATCHDOG_FAILURES)"

        if [ "$WATCHDOG_FAILURES" -ge "$MAX_WATCHDOG_FAILURES" ]; then
            log "Restarting work container after $MAX_WATCHDOG_FAILURES consecutive failures..."
            local_container=$(cat "$STATE_CONTAINER" 2>/dev/null || echo "feather-work-blue")
            hostpodman restart "$local_container" 2>/dev/null || true
            WATCHDOG_FAILURES=0
            sleep 10
        fi
    fi
done
