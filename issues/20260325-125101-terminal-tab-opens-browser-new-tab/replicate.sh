#!/bin/bash
# Exit 0 = bug present, Exit 1 = bug absent
set -euo pipefail

ISSUE_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${ISSUE_DIR}/../.." && pwd)"
APP_TSX="${ROOT}/frontend/src/App.tsx"
TERMINAL_TSX="${ROOT}/frontend/src/components/Terminal.tsx"

if ! grep -Fq "<button onClick={() => setTab('terminal')} style={tabStyle('terminal')}>Terminal</button>" "$APP_TSX"; then
  echo "BUG PRESENT: Terminal switcher is no longer the plain setTab('terminal') button checked by this detector"
  exit 0
fi

if grep -Fq "chrome://new-tab-page/" "$APP_TSX" "$TERMINAL_TSX"; then
  echo "BUG PRESENT: frontend source still references chrome://new-tab-page/"
  exit 0
fi

if grep -Fq "window.open(" "$APP_TSX" "$TERMINAL_TSX"; then
  echo "BUG PRESENT: frontend source still opens a new browser tab from the Chat/Terminal view code"
  exit 0
fi

if grep -Eq "location\\.(href|assign|replace)" "$APP_TSX" "$TERMINAL_TSX"; then
  echo "BUG PRESENT: frontend source still performs direct location navigation from the Chat/Terminal view code"
  exit 0
fi

if ! grep -Fq "<Terminal sessionId={tab() === 'terminal' ? currentId() : null} />" "$APP_TSX"; then
  echo "BUG PRESENT: Terminal tab no longer renders the in-app Terminal component"
  exit 0
fi

if ! grep -Fq 'ws = new WebSocket(`${BASE_WS}?session=${sessionId}`)' "$TERMINAL_TSX"; then
  echo "BUG PRESENT: Terminal component no longer connects in place via WebSocket"
  exit 0
fi

echo "BUG ABSENT: Terminal is implemented as an in-app tab toggle plus embedded WebSocket terminal, with no new-tab navigation path in the current source"
exit 1
