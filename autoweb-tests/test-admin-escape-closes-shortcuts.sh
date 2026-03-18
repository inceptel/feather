#!/bin/bash
# test-admin-escape-closes-shortcuts.sh
# Admin: Escape key (outside input) should close the shortcuts panel when open
ADMIN_HTML="/opt/feather/static/admin/index.html"

# Escape handler outside input guard must close the shortcuts panel
grep -A5 "key === 'Escape'" "$ADMIN_HTML" | grep -q "admin-shortcuts-panel" || { echo "FAIL: Escape key does not reference admin-shortcuts-panel"; exit 1; }

# The Escape handler outside input guard must call toggleShortcuts
grep -A5 "key === 'Escape'" "$ADMIN_HTML" | grep -q "toggleShortcuts" || { echo "FAIL: Escape key does not call toggleShortcuts"; exit 1; }

# Esc hint in shortcuts panel should mention 'close panel'
grep -q "close panel" "$ADMIN_HTML" || { echo "FAIL: Esc shortcut hint does not mention 'close panel'"; exit 1; }

echo "PASS: Escape closes shortcuts panel"
exit 0
