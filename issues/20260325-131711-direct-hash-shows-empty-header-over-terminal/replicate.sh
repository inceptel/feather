#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
TARGET_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"
TERMINAL_TSX="/home/user/feather-dev/w5/frontend/src/components/Terminal.tsx"
URL="http://localhost:${PORT}/#${TARGET_ID}"
SESSION_JSON=""
# The split-brain state depends on a direct hash setting currentId even when the
# session is missing from the fetched session list.
rg -q "const hash = location.hash.slice\\(1\\)" "$APP_TSX"
rg -q "if \\(hash\\) select\\(hash\\)" "$APP_TSX"
rg -q "const cur = \\(\\) => sessions\\(\\)\\.find\\(s => s\\.id === currentId\\(\\)\\)" "$APP_TSX"
rg -q "Show when=\\{cur\\(\\)\\}" "$APP_TSX"
rg -q "Select a session" "$APP_TSX"
rg -q "<Show when=\\{currentId\\(\\)\\}>" "$APP_TSX"
rg -q "Terminal sessionId=\\{tab\\(\\) === 'terminal' \\? currentId\\(\\) : null\\}" "$APP_TSX"
rg -q "new-dev/api/terminal" "$TERMINAL_TSX"

SESSION_JSON="$(curl -fsS "http://localhost:${PORT}/api/sessions")"
if printf '%s' "$SESSION_JSON" | rg -q "\"id\": \"${TARGET_ID}\""; then
  echo "BUG ABSENT: target session is present in /api/sessions, so the header fallback should not trigger"
  exit 1
fi

echo "BUG PRESENT"
echo "direct hash ${TARGET_ID} is absent from /api/sessions on port ${PORT}, but App.tsx still promotes location.hash into currentId() and renders tabs/content from currentId() while the header title falls back from cur() to 'Select a session'"
exit 0
