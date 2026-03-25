#!/bin/bash
# Feather launch script
# Used by supervisord, or run manually: ./run.sh

cd "$(dirname "$0")"

# Install deps if needed
[ -d node_modules ] || npm install
[ -d frontend/node_modules ] || (cd frontend && npm install)

# Build frontend if static/ is missing
[ -d static/assets ] || (cd frontend && npm run build)

exec node server.js
