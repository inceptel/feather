#!/bin/bash
# Compile Feather. Does NOT restart or deploy.
# Use deploy.sh to build + test + swap + restart.
set -e
cd "$(dirname "$0")/.."

VERSION=$(TZ=America/New_York date +%Y%m%d-%H%M)
echo "=== Build: $VERSION ==="

echo "[1/2] Compiling..."
export PATH="/usr/local/cargo/bin:$PATH"
cargo build --release

echo "[2/2] Stamping version: $VERSION"
sed -i "s|<p class=\"text-xs text-smoke-9 ml-7\">.*</p>|<p class=\"text-xs text-smoke-9 ml-7\">$VERSION</p>|" static/index.html

echo "=== Built: $VERSION (not deployed — run deploy.sh to ship) ==="
