#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"

MENU_LINE="$(rg -n "position: 'fixed'.*left: '12px'.*width: '44px'.*height: '44px'" "$APP_TSX" || true)"
HEADER_LINE="$(rg -n "padding: '8px 16px 0 56px'" "$APP_TSX" || true)"
TITLE_LINE="$(rg -n "Select a session" "$APP_TSX" || true)"

if [ -n "$MENU_LINE" ] && [ -n "$HEADER_LINE" ] && [ -n "$TITLE_LINE" ]; then
  echo "BUG PRESENT: header title starts at 56px while the fixed menu button occupies the first 56px"
  exit 0
fi

echo "BUG ABSENT: source no longer matches the zero-gap mobile header layout"
exit 1
