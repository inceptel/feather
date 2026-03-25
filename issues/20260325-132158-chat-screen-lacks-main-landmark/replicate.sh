#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

APP_TSX="${WORKTREE:-/home/user/feather-dev/w5}/frontend/src/App.tsx"

if [ ! -f "$APP_TSX" ]; then
  echo "Missing source file: $APP_TSX"
  exit 1
fi

if ! grep -Fq '<MessageView messages={messages()} loading={loading()} />' "$APP_TSX"; then
  echo "Chat transcript mount not found in App.tsx"
  exit 1
fi

if grep -Eq '<main[[:space:]>]|role="main"|role='\''main'\''' "$APP_TSX"; then
  echo "BUG ABSENT: App.tsx defines a main landmark"
  exit 1
fi

echo "BUG PRESENT: chat transcript is mounted without any <main> or role=\"main\" landmark in App.tsx"
exit 0
