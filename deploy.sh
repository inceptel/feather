#!/bin/bash
# deploy.sh — Compile and deploy feather-rs, avoiding ETXTBSY errors
# Usage: ./deploy.sh [--frontend-only]
#
# The key insight: on Linux, you cannot write to an executable that's running.
# cargo build fails with ETXTBSY. Fix: rm the binary before compiling.
# The running process keeps its fd reference; rm just unlinks the directory entry.

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$DIR/target/release/feather-rs"
BACKUP="$BINARY.bak"
LOG="$DIR/feather-dev.log"
PORT="${PORT:-4860}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $*"; }
error() { echo -e "${RED}[deploy]${NC} $*" >&2; }

health_check() {
    local retries=5
    local delay=1
    for i in $(seq 1 $retries); do
        if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep "$delay"
    done
    return 1
}

# Frontend-only mode: no compile needed
if [[ "${1:-}" == "--frontend-only" ]]; then
    info "Frontend-only deploy — static files served live, nothing to do."
    exit 0
fi

cd "$DIR"
source ~/.cargo/env 2>/dev/null || true

# 1. Back up current binary
if [[ -f "$BINARY" ]]; then
    cp "$BINARY" "$BACKUP"
    info "Backed up binary to $BACKUP"
fi

# 2. Remove binary to prevent ETXTBSY (process keeps running via fd reference)
if [[ -f "$BINARY" ]]; then
    rm -f "$BINARY"
    info "Removed old binary (running process unaffected)"
fi

# 3. Compile
info "Compiling..."
if ! cargo build --release 2>&1; then
    error "Compile failed — restoring backup"
    if [[ -f "$BACKUP" ]]; then
        cp "$BACKUP" "$BINARY"
    fi
    exit 1
fi
info "Compile succeeded"

# 4. Stop old process
info "Stopping old process..."
pkill -u "$(whoami)" -f feather-rs || true
sleep 1

# 5. Start new process
info "Starting new process on port $PORT..."
cd "$DIR"
PORT="$PORT" nohup "$BINARY" > "$LOG" 2>&1 &
sleep 2

# 6. Health check
if health_check; then
    info "Health check passed — deploy complete"
    # Clean up backup
    rm -f "$BACKUP"
    exit 0
else
    error "HEALTH CHECK FAILED — reverting"
    pkill -u "$(whoami)" -f feather-rs || true
    sleep 1
    if [[ -f "$BACKUP" ]]; then
        cp "$BACKUP" "$BINARY"
        cd "$DIR"
        PORT="$PORT" nohup "$BINARY" > "$LOG" 2>&1 &
        sleep 2
        if health_check; then
            warn "Reverted to previous binary — service restored"
        else
            error "CRITICAL: revert also failed, service is down"
        fi
    fi
    exit 1
fi
