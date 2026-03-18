#!/bin/bash
# Test: major modals have role="menu" for context menu
set -e
FILE=/opt/feather/static/index.html

# Session context menu has role="menu"
grep 'id="session-ctx-menu"' "$FILE" | grep -q 'role="menu"' || { echo "FAIL: session-ctx-menu missing role=menu"; exit 1; }

echo "PASS: modal aria roles"
