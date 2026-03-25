#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

APP_TSX="${WORKTREE:-/home/user/feather-dev/w5}/frontend/src/App.tsx"

if [ ! -f "$APP_TSX" ]; then
  echo "Missing source file: $APP_TSX"
  exit 1
fi

if ! grep -Fq "fallback={<span style={{ color: '#666', 'font-size': '14px' }}>Select a session</span>}" "$APP_TSX"; then
  echo "Landing header fallback not found in App.tsx"
  exit 1
fi

if ! grep -Fq "<div>Open a session or create a new one</div>" "$APP_TSX"; then
  echo "Landing empty-state body not found in App.tsx"
  exit 1
fi

if grep -Eq '<main[[:space:]>]|role="main"|role='\''main'\''' "$APP_TSX"; then
  echo "BUG ABSENT: App.tsx defines a main landmark"
  exit 1
fi

echo "BUG PRESENT: landing screen fallback renders without any <main> or role=\"main\" landmark in App.tsx"
exit 0
