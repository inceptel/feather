#!/bin/bash
# test-admin-shortcuts-panel.sh
# Admin page: '?' key should toggle a keyboard shortcuts panel
ADMIN_HTML="/opt/feather/static/admin/index.html"

# Check the shortcuts panel exists
grep -q 'id="admin-shortcuts-panel"' "$ADMIN_HTML" || { echo "FAIL: no admin-shortcuts-panel element"; exit 1; }
# Check it starts hidden
grep -q 'admin-shortcuts-panel.*hidden' "$ADMIN_HTML" || { echo "FAIL: shortcuts panel should start hidden"; exit 1; }
# Check toggleShortcuts function exists
grep -q 'function toggleShortcuts' "$ADMIN_HTML" || { echo "FAIL: no toggleShortcuts() function"; exit 1; }
# Check '?' key handler exists
grep -q "key === '?'" "$ADMIN_HTML" || { echo "FAIL: no '?' key handler"; exit 1; }
# Check '?' key calls toggleShortcuts
grep -A2 "key === '?'" "$ADMIN_HTML" | grep -q "toggleShortcuts" || { echo "FAIL: '?' key does not call toggleShortcuts"; exit 1; }
# Check ? button in header
grep -q 'id="admin-shortcuts-btn"' "$ADMIN_HTML" || { echo "FAIL: no admin-shortcuts-btn button"; exit 1; }

echo "PASS: admin shortcuts panel with ? key toggle"
exit 0
