#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

ROOT="${WORKTREE:-/home/user/feather-dev/w5}"
APP_COMPONENT="$ROOT/frontend/src/App.tsx"

if [ ! -f "$APP_COMPONENT" ]; then
  echo "BUG ABSENT: missing $APP_COMPONENT"
  exit 1
fi

TAB_BLOCK="$(sed -n '236,257p' "$APP_COMPONENT")"

if printf '%s\n' "$TAB_BLOCK" | grep -Fq "<button onClick={() => setTab('chat')} style={tabStyle('chat')}>Chat</button>" \
  && printf '%s\n' "$TAB_BLOCK" | grep -Fq "<button onClick={() => setTab('terminal')} style={tabStyle('terminal')}>Terminal</button>" \
  && ! printf '%s\n' "$TAB_BLOCK" | grep -Eq 'role=|aria-selected=|aria-controls=|tabpanel|tablist'
then
  echo "BUG PRESENT: Chat/Terminal switcher is still rendered as plain buttons with no tab semantics"
  exit 0
fi

echo "BUG ABSENT: Chat/Terminal switcher no longer matches the plain-button implementation"
exit 1
