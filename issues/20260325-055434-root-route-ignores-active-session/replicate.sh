#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:$PORT"
PREFERRED_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"

SESSIONS_JSON="$(curl -fsS "$BASE/api/sessions?limit=50")"
TARGET_ID="$(printf '%s' "$SESSIONS_JSON" | jq -r --arg preferred "$PREFERRED_ID" '(.sessions // []) as $s | (($s[] | select(.id == $preferred) | .id), ($s[0].id)) // empty' | head -n 1)"

if [ -z "$TARGET_ID" ]; then
  echo "BUG ABSENT: no existing session available from $BASE/api/sessions"
  exit 1
fi

curl -fsS -X POST "$BASE/api/sessions/$TARGET_ID/resume" \
  -H 'Content-Type: application/json' \
  -d '{}' >/dev/null

ACTIVE="false"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  ACTIVE="$(curl -fsS "$BASE/api/sessions?limit=50" | jq -r --arg id "$TARGET_ID" 'first((.sessions // [])[] | select(.id == $id) | if .isActive then "true" else "false" end) // "false"')"
  [ "$ACTIVE" = "true" ] && break
  sleep 1
done

if [ "$ACTIVE" != "true" ]; then
  echo "BUG ABSENT: could not establish an active session for $TARGET_ID"
  exit 1
fi

HASH_ONLY_RESTORE="$(rg -n "const hash = location.hash.slice\\(1\\)" "$APP_TSX" || true)"
HASH_SELECT_ONLY="$(rg -n "if \\(hash\\) select\\(hash\\)" "$APP_TSX" || true)"
EMPTY_STATE_TITLE="$(rg -n "Select a session" "$APP_TSX" || true)"
EMPTY_STATE_COPY="$(rg -n "Open a session or create a new one" "$APP_TSX" || true)"

if [ -n "$HASH_ONLY_RESTORE" ] && [ -n "$HASH_SELECT_ONLY" ] && [ -n "$EMPTY_STATE_TITLE" ] && [ -n "$EMPTY_STATE_COPY" ]; then
  echo "BUG PRESENT: backend has active session $TARGET_ID but App.tsx only restores from location.hash and otherwise renders the empty state"
  exit 0
fi

echo "BUG ABSENT: root route restore logic no longer matches the reported empty-state fallback"
exit 1
