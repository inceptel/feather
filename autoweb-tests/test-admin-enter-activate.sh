#!/bin/bash
# Test: Enter key activates (copies name of) the focused service card in admin
FILE="/opt/feather/static/admin/index.html"

# activateFocusedService function exists
grep -q "function activateFocusedService" "$FILE" || { echo "FAIL: activateFocusedService function not found"; exit 1; }

# Enter key handler exists and calls activateFocusedService
grep -q "e.key === 'Enter'" "$FILE" || { echo "FAIL: Enter key handler not found"; exit 1; }
grep -q "activateFocusedService()" "$FILE" || { echo "FAIL: activateFocusedService() call not found"; exit 1; }

# Documented in shortcuts panel
grep -q "Copy focused service name" "$FILE" || { echo "FAIL: Enter shortcut not documented in shortcuts panel"; exit 1; }

echo "PASS: Admin Enter key activates focused service card"
exit 0
