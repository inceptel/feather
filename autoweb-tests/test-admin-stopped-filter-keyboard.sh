#!/bin/bash
# Test: 'S' keyboard shortcut is handled in admin keydown listener
# and shortcuts panel documents it
FILE="/opt/feather/static/admin/index.html"

# Check S key handler calls toggleStoppedFilter
if ! grep -q "e.key === 's' || e.key === 'S'" "$FILE"; then
    echo "FAIL: S key handler missing in admin keydown"
    exit 1
fi

if ! grep -q "toggleStoppedFilter()" "$FILE" | grep -q "e.key"; then
    : # grep chaining doesn't work like this; just check both exist
fi

# Simpler: check S key block calls toggleStoppedFilter
if ! grep -A5 "e.key === 's' || e.key === 'S'" "$FILE" | grep -q "toggleStoppedFilter"; then
    echo "FAIL: S key handler does not call toggleStoppedFilter"
    exit 1
fi

# Check shortcuts panel documents S
if ! grep -q "Toggle stopped filter" "$FILE"; then
    echo "FAIL: shortcuts panel missing S shortcut documentation"
    exit 1
fi

echo "PASS: admin S keyboard shortcut for stopped filter"
