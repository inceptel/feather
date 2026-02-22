#!/bin/bash
# Run the test suite
set -e
cd /opt/feather

echo "=== Feather Tests ==="

# Install test deps if needed
if [ ! -d node_modules ]; then
    echo "Installing test dependencies..."
    npm install
    npx playwright install chromium
fi

# Run tests
npm test
