#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE_URL="http://localhost:${PORT}/"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "$BASE_URL" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 2000 >/dev/null

BODY_TEXT="$(agent-browser --session-name "$S" eval 'document.body.innerText')"

HAS_SOURCE_LITERAL=0
if rg -Fq "<div style={{ 'font-size': '32px', 'margin-bottom': '12px', opacity: '0.3' }}>~</div>" "$APP_TSX"; then
  HAS_SOURCE_LITERAL=1
fi

if [ "$HAS_SOURCE_LITERAL" -eq 1 ] && \
  printf '%s' "$BODY_TEXT" | rg -Fq 'Select a session' && \
  printf '%s' "$BODY_TEXT" | rg -Fq '~' && \
  printf '%s' "$BODY_TEXT" | rg -Fq 'Open a session or create a new one'; then
  echo "BUG PRESENT: empty state renders a standalone ~ between the title and helper copy, matching frontend/src/App.tsx"
  exit 0
fi

echo "BUG ABSENT: no standalone empty-state tilde sequence detected"
exit 1
