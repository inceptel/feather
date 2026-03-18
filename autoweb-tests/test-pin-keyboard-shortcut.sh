#!/bin/bash
# Test: X keyboard shortcut to pin/unpin current session
set -e
RESULT=$(grep -c "key === 'x'" /opt/feather/static/index.html)
[ "$RESULT" -ge 1 ] || { echo "FAIL: no x key handler found"; exit 1; }
# Verify it calls togglePinSession
grep "key === 'x'" /opt/feather/static/index.html -A 8 | grep -q "togglePinSession" || { echo "FAIL: x key doesn't call togglePinSession"; exit 1; }
# Verify it's in command palette
grep -q "Pin/unpin current session" /opt/feather/static/index.html || { echo "FAIL: not in command palette"; exit 1; }
echo "PASS"
