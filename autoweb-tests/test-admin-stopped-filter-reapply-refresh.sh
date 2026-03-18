#!/bin/bash
# Test: renderServices re-applies stopped filter after auto-refresh
# Bug: when the 30s auto-refresh calls renderServices, stoppedFilterActive state
# was not re-applied — all services would reappear even if stopped filter was on.
FILE=/opt/feather/static/admin/index.html

# renderServices must contain stoppedFilterActive re-apply logic
if ! grep -A 120 "function renderServices" "$FILE" | grep -q "stoppedFilterActive"; then
    echo "FAIL: renderServices must re-apply stoppedFilterActive filter after re-render"
    exit 1
fi

# The re-apply block should hide non-stopped (non-ember) items
if ! grep -A 120 "function renderServices" "$FILE" | grep -q "bg-ember-9"; then
    echo "FAIL: renderServices stopped-filter re-apply should filter by bg-ember-9 dot color"
    exit 1
fi

echo "PASS: renderServices re-applies stopped filter after auto-refresh"
