#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

APP_FILE="${APP_FILE:-/home/user/feather-dev/w5/frontend/src/App.tsx}"

BLOCK="$(awk '
  /onClick=\{handleNew\}/ { capture=1 }
  capture { print }
  /\+ New Claude/ { exit }
' "$APP_FILE")"

if [ -z "$BLOCK" ]; then
  echo "BUG ABSENT: could not find New Claude button block in $APP_FILE"
  exit 1
fi

if printf '%s\n' "$BLOCK" | grep -Fq "padding: '10px'" \
  && ! printf '%s\n' "$BLOCK" | grep -Eq "'(min-)?height': '44px'|height: '44px'|min-height: '44px'"; then
  echo "BUG PRESENT: New Claude button block uses 10px padding without a 44px height floor"
  exit 0
fi

echo "BUG ABSENT: New Claude button block no longer matches the undersized mobile styles"
exit 1
