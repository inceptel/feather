#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:${PORT}"
ISSUE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_TSX="${ISSUE_DIR%/issues/*}/frontend/src/App.tsx"
TARGET_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
TARGET_TITLE="hello old friend"

SESSIONS_JSON="$(curl -fsS "${BASE}/api/sessions?limit=500")"
TARGET_ROW="$(jq -r --arg id "$TARGET_ID" 'first((.sessions // [])[] | select(.id == $id) | [.id, .title, .isActive]) | @tsv' <<<"$SESSIONS_JSON")"
if [ -z "$TARGET_ROW" ] || [ "$TARGET_ROW" = "null" ]; then
  echo "BUG ABSENT: target session ${TARGET_ID} is not present in ${BASE}/api/sessions?limit=500"
  exit 1
fi

TARGET_SEEN_TITLE="$(cut -f2 <<<"$TARGET_ROW")"
TARGET_IS_ACTIVE="$(cut -f3 <<<"$TARGET_ROW")"
if [ "$TARGET_SEEN_TITLE" != "$TARGET_TITLE" ]; then
  echo "BUG ABSENT: target session title is '${TARGET_SEEN_TITLE}', expected '${TARGET_TITLE}'"
  exit 1
fi
if [ "$TARGET_IS_ACTIVE" != "true" ]; then
  echo "BUG ABSENT: target session ${TARGET_ID} is not active in the backend"
  exit 1
fi

HAS_ARIA_CURRENT=0
if rg -n -F "aria-current={s.id === currentId() ? 'page' : undefined}" "$APP_TSX" >/dev/null; then
  HAS_ARIA_CURRENT=1
fi

HAS_NON_COLOR_SELECTION=0
if rg -n -F "'border-left': s.id === currentId() ? '3px solid #4aba6a' : '3px solid transparent'" "$APP_TSX" >/dev/null; then
  HAS_NON_COLOR_SELECTION=1
fi

HAS_ACTIVE_DOT=0
if rg -n -F "<Show when={s.isActive}><span style={{ width: '6px', height: '6px', 'border-radius': '50%', background: '#4aba6a', 'flex-shrink': '0' }} /></Show>" "$APP_TSX" >/dev/null; then
  HAS_ACTIVE_DOT=1
fi

if [ "$HAS_ARIA_CURRENT" -eq 0 ] && [ "$HAS_NON_COLOR_SELECTION" -eq 0 ] && [ "$HAS_ACTIVE_DOT" -eq 1 ]; then
  echo "BUG PRESENT: active drawer row still relies on the green dot alone, with no aria-current and no non-color selected indicator"
  exit 0
fi

echo "BUG ABSENT: App.tsx marks the current session with aria-current and a 3px left border instead of relying on the green dot alone"
exit 1
