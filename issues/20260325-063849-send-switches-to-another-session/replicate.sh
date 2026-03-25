#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
BASE="http://localhost:$PORT"
TARGET_ID="4baa1292-7fdf-4e87-af47-6731e459b3cd"
TARGET_TITLE="worker 4 probe"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"
SERVER_JS="/home/user/feather-dev/w5/server.js"

FULL_LIST="$(curl -fsS "$BASE/api/sessions?limit=500")"
DEFAULT_LIST="$(curl -fsS "$BASE/api/sessions")"

if ! jq -e --arg id "$TARGET_ID" --arg title "$TARGET_TITLE" \
  'any((.sessions // [])[]; .id == $id and .title == $title)' >/dev/null <<<"$FULL_LIST"; then
  echo "BUG ABSENT: target foreign session $TARGET_ID ($TARGET_TITLE) is not present in $BASE/api/sessions?limit=500"
  exit 1
fi

if jq -e --arg id "$TARGET_ID" 'any((.sessions // [])[]; .id == $id)' >/dev/null <<<"$DEFAULT_LIST"; then
  echo "BUG ABSENT: target session is still in the default 50-session list, so this stale-hash/off-list path is not active"
  exit 1
fi

HASH_RESTORE="$(rg -n "const hash = location.hash.slice\\(1\\)|if \\(hash\\) select\\(hash\\)" "$APP_TSX" || true)"
HEADER_LOOKUP="$(rg -n "const cur = \\(\\) => sessions\\(\\)\\.find\\(s => s\\.id === currentId\\(\\)\\)" "$APP_TSX" || true)"
SEND_PATH="$(rg -n "if \\(\\(!val && !pending.length\\) \\|\\| !currentId\\(\\)\\) return|sendInput\\(currentId\\(\\)!," "$APP_TSX" || true)"
GLOBAL_SCAN="$(rg -n "function findJsonlPath|for \\(const dir of fs\\.readdirSync\\(CLAUDE_PROJECTS\\)\\)|sendInput\\(id, text\\)" "$SERVER_JS" || true)"

if [ -z "$HASH_RESTORE" ] || [ -z "$HEADER_LOOKUP" ] || [ -z "$SEND_PATH" ] || [ -z "$GLOBAL_SCAN" ]; then
  echo "BUG ABSENT: source checks no longer show the stale-hash/off-list send path"
  exit 1
fi

echo "BUG PRESENT: $BASE can still restore hidden session $TARGET_ID from location.hash even though /api/sessions omits it from the visible list, and App.tsx sends using currentId() while server.js resolves any matching session id across shared ~/.claude/projects storage"
exit 0
