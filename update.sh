#!/bin/bash
# Pull latest and rebuild Feather
set -e
cd /opt/feather

echo "=== Feather Update ==="

# Pull latest
echo "[1/3] Pulling latest..."
git pull origin master

# Build
echo "[2/3] Building..."
cargo build --release

# Restart
echo "[3/3] Restarting Feather..."
sudo cp target/release/feather-rs /usr/local/bin/feather
sudo supervisorctl restart feather

echo ""
echo "=== Updated to $(git log --oneline -1) ==="
