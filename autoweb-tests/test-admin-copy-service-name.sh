#!/bin/bash
# Test: admin service names are clickable buttons with copy behavior
FILE="/opt/feather/static/admin/index.html"

# Check copyServiceName function exists
grep -q "function copyServiceName" "$FILE" || { echo "FAIL: copyServiceName function missing"; exit 1; }

# Check service name is rendered as a button (not a span)
grep -q "onclick=\"copyServiceName(this" "$FILE" || { echo "FAIL: service name not clickable button"; exit 1; }

# Check clipboard.writeText is used
grep -q "clipboard.writeText(name)" "$FILE" || { echo "FAIL: clipboard.writeText not used"; exit 1; }

echo "PASS: admin service names are clickable copy buttons"
exit 0
