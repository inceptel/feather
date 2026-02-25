#!/bin/bash
set -euo pipefail

# Feather install script — run on a fresh Ubuntu 22.04/24.04 VPS as root
# Usage:
#   DOMAIN=feather.example.com ACME_EMAIL=me@example.com \
#     FEATHER_ANTHROPIC_API_KEY=sk-ant-... \
#     FEATHER_OPENAI_API_KEY=sk-... \
#     curl -fsSL https://feather.dev/install | bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[feather]${NC} $*"; }
warn() { echo -e "${YELLOW}[feather]${NC} $*"; }
err()  { echo -e "${RED}[feather]${NC} $*" >&2; }

# --- 1. Validate environment ---
if [ "$(id -u)" -ne 0 ]; then
    err "This script must be run as root"
    exit 1
fi

. /etc/os-release 2>/dev/null || true
if [[ "${VERSION_ID:-}" != "22.04" && "${VERSION_ID:-}" != "24.04" ]]; then
    err "Unsupported OS: requires Ubuntu 22.04 or 24.04 (got ${PRETTY_NAME:-unknown})"
    exit 1
fi

log "Installing Feather on ${PRETTY_NAME}..."

# --- 2. Install podman ---
log "Installing podman..."
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg > /dev/null

mkdir -p /etc/apt/keyrings
rm -f /etc/apt/keyrings/kubic.gpg
curl -fsSL "https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/unstable/xUbuntu_${VERSION_ID}/Release.key" \
    | gpg --batch --dearmor -o /etc/apt/keyrings/kubic.gpg

echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/kubic.gpg] https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/unstable/xUbuntu_${VERSION_ID}/ /" \
    > /etc/apt/sources.list.d/kubic.list

apt-get update -qq
apt-get install -y -qq podman fuse-overlayfs slirp4netns crun uidmap > /dev/null
log "Podman $(podman --version | awk '{print $3}') installed"

# --- 3. Install git ---
apt-get install -y -qq git > /dev/null

# --- 4. Clone feather ---
FEATHER_SRC="/opt/feather-src"
if [ -d "$FEATHER_SRC/.git" ]; then
    log "Feather source exists, pulling latest..."
    git -C "$FEATHER_SRC" pull --ff-only || true
else
    log "Cloning Feather..."
    git clone https://github.com/inceptel/feather.git "$FEATHER_SRC"
fi

# --- 5. Build work container image ---
log "Building work container image (this may take 3-10 minutes on first run)..."
podman build -t localhost/feather-work:latest -f "$FEATHER_SRC/Containerfile" "$FEATHER_SRC/"
log "Work container image built"

# --- 6. Build birth certificate image ---
log "Building birth certificate image..."
podman build -t localhost/feather-birth:latest -f "$FEATHER_SRC/birth/Containerfile" "$FEATHER_SRC/birth/"
log "Birth certificate image built"

# --- 7. Configure firewall ---
if command -v ufw > /dev/null 2>&1; then
    log "Configuring UFW..."
    ufw allow 22/tcp > /dev/null 2>&1 || true
    ufw allow 80/tcp > /dev/null 2>&1 || true
    ufw allow 443/tcp > /dev/null 2>&1 || true
    ufw --force enable > /dev/null 2>&1 || true
    log "UFW configured (22, 80, 443)"
fi

# --- 8. Enable podman socket ---
log "Enabling podman socket..."
systemctl enable --now podman.socket
log "Podman socket at /run/podman/podman.sock"

# --- 9. Create systemd service ---
log "Creating systemd service..."

# Build environment flags
ENV_FLAGS=""
[ -n "${DOMAIN:-}" ]                     && ENV_FLAGS="$ENV_FLAGS -e DOMAIN=$DOMAIN"
[ -n "${ACME_EMAIL:-}" ]                 && ENV_FLAGS="$ENV_FLAGS -e ACME_EMAIL=$ACME_EMAIL"
[ -n "${FEATHER_ANTHROPIC_API_KEY:-}" ]  && ENV_FLAGS="$ENV_FLAGS -e FEATHER_ANTHROPIC_API_KEY=$FEATHER_ANTHROPIC_API_KEY"
[ -n "${FEATHER_OPENAI_API_KEY:-}" ]     && ENV_FLAGS="$ENV_FLAGS -e FEATHER_OPENAI_API_KEY=$FEATHER_OPENAI_API_KEY"
[ -n "${ANTHROPIC_API_KEY:-}" ]          && ENV_FLAGS="$ENV_FLAGS -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
[ -n "${OPENAI_API_KEY:-}" ]             && ENV_FLAGS="$ENV_FLAGS -e OPENAI_API_KEY=$OPENAI_API_KEY"

cat > /etc/systemd/system/feather.service << UNIT
[Unit]
Description=Feather Birth Certificate
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=5

ExecStartPre=-/usr/bin/podman stop -t 15 feather-birth
ExecStartPre=-/usr/bin/podman rm -f feather-birth

ExecStartPre=-/usr/bin/podman stop -t 10 feather-work-blue
ExecStartPre=-/usr/bin/podman stop -t 10 feather-work-green
ExecStartPre=-/usr/bin/podman rm -f feather-work-blue
ExecStartPre=-/usr/bin/podman rm -f feather-work-green

ExecStart=/usr/bin/podman run \\
    --name feather-birth \\
    --network=host \\
    -v /run/podman/podman.sock:/run/podman/podman.sock \\
    -v ${FEATHER_SRC}:/opt/feather-src:ro \\
    ${ENV_FLAGS} \\
    localhost/feather-birth:latest

ExecStop=/usr/bin/podman stop -t 15 feather-birth
ExecStopPost=-/usr/bin/podman rm -f feather-birth

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable feather.service
systemctl start feather.service

# --- 9. Print summary ---
echo ""
echo "============================================"
log "Feather installed successfully!"
echo "============================================"
echo ""

if [ -n "${DOMAIN:-}" ]; then
    log "Access: https://${DOMAIN}"
    log "TLS certificates will be provisioned automatically"
else
    IP=$(curl -sf https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    log "Access: http://${IP}"
    warn "No DOMAIN set — running in HTTP-only mode"
    warn "Set DOMAIN and ACME_EMAIL for TLS"
fi

echo ""
log "Useful commands:"
echo "  systemctl status feather        # Check service status"
echo "  journalctl -u feather -f        # Follow logs"
echo "  podman exec feather-birth swap.sh  # Zero-downtime update"
echo ""
log "To update Feather:"
echo "  cd ${FEATHER_SRC} && git pull"
echo "  podman build -t localhost/feather-work:latest -f Containerfile ."
echo "  podman exec feather-birth swap.sh"
echo ""
