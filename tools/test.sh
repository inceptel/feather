#!/bin/bash
# Run the Playwright test suite.
# Usage:
#   ./tools/test.sh          # test production (:4850)
#   ./tools/test.sh 4851     # test canary (:4851)
set -e
cd "$(dirname "$0")/.."

PORT="${1:-4850}"
URL="http://localhost:$PORT"

echo "=== Feather Tests (targeting $URL) ==="

# Install test deps if needed
if [ ! -d node_modules ]; then
    echo "Installing test dependencies..."
    npm install
    npx playwright install chromium
fi

# Verify target is reachable
if ! curl -sf "$URL/health" > /dev/null 2>&1; then
    echo "ERROR: $URL is not reachable"
    exit 1
fi

# Run tests
FEATHER_URL="$URL" npx playwright test tests/e2e.spec.js --reporter=list
