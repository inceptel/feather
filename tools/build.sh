#!/bin/bash
# Compile, stamp version, restart Feather (no git operations)
set -e
cd /opt/feather

VERSION=$(TZ=America/New_York date +%Y%m%d-%H%M)
echo "=== Build: $VERSION ==="

echo "[1/3] Compiling..."
cargo build --release

echo "[2/3] Stamping: $VERSION"
sed -i "s|<p class=\"text-xs text-smoke-9 ml-7\">.*</p>|<p class=\"text-xs text-smoke-9 ml-7\">$VERSION</p>|" static/index.html

echo "[3/3] Restarting..."
sudo cp target/release/feather-rs /usr/local/bin/feather
sudo supervisorctl restart feather

echo "=== Built: $VERSION ==="
