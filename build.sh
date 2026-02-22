#!/bin/bash
# Build feather and restart locally
set -e

cd "$(dirname "$0")"

VERSION=$(TZ=America/New_York date +%Y%m%d-%H%M)
echo "=== Build: $VERSION ==="

# 1. Compile
echo "[1/3] Compiling..."
cargo build --release

# 2. Stamp version
echo "[2/3] Stamping: $VERSION"
sed -i "s|<p class=\"text-xs text-smoke-9 ml-7\">.*</p>|<p class=\"text-xs text-smoke-9 ml-7\">$VERSION</p>|" static/index.html

# 3. Install + restart
echo "[3/3] Restarting..."
cp static/* /opt/feather/static/
sudo rm -f /usr/local/bin/feather
sudo cp target/release/feather-rs /usr/local/bin/feather
pkill -x feather || true
sleep 1

echo ""
echo "=== Built: $VERSION ==="
