#!/bin/bash
# Pull latest + build + restart (the full cycle)
set -e
cd /opt/feather

echo "=== Feather Update ==="

echo "[1/3] Pulling latest..."
git pull origin master

echo "[2/3] Building..."
./tools/build.sh

echo "=== Updated to $(git log --oneline -1) ==="
