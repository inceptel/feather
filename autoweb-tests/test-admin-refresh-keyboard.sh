#!/bin/bash
# test-admin-refresh-keyboard.sh
# Admin page: 'R' key should trigger refreshStatus()
ADMIN_HTML="/opt/feather/static/admin/index.html"

# Check R keyboard shortcut handler exists
grep -q "key === 'r'" "$ADMIN_HTML" || { echo "FAIL: no 'r' key handler in admin page"; exit 1; }
grep -q "key === 'R'" "$ADMIN_HTML" || { echo "FAIL: no 'R' key handler in admin page"; exit 1; }
# Confirm it calls refreshStatus
grep -A2 "key === 'r'" "$ADMIN_HTML" | grep -q "refreshStatus" || { echo "FAIL: 'r' key does not call refreshStatus"; exit 1; }
# Check the refresh button has an 'r' hint
grep -q 'title="Refresh (R)"' "$ADMIN_HTML" || { echo "FAIL: Refresh button missing title tooltip with shortcut hint"; exit 1; }

echo "PASS: admin R keyboard shortcut for refresh"
exit 0
