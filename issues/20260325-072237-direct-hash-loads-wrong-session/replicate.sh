#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
BASE="http://localhost:${PORT}"
TARGET_ID="4baa1292-7fdf-4e87-af47-6731e459b3cd"
TARGET_TITLE="worker 4 probe"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"

FULL_LIST="$(curl -fsS "$BASE/api/sessions?limit=500")"
DEFAULT_LIST="$(curl -fsS "$BASE/api/sessions")"
TARGET_ROW="$(jq -r --arg id "$TARGET_ID" 'first((.sessions // [])[] | select(.id == $id) | [.id, .title, .isActive]) | @tsv' <<<"$FULL_LIST")"

if [ -z "$TARGET_ROW" ]; then
  echo "BUG ABSENT: target session $TARGET_ID is unavailable from $BASE/api/sessions?limit=500"
  exit 1
fi

TARGET_SEEN_TITLE="$(printf '%s\n' "$TARGET_ROW" | cut -f2)"
TARGET_ACTIVE="$(printf '%s\n' "$TARGET_ROW" | cut -f3)"
if [ "$TARGET_SEEN_TITLE" != "$TARGET_TITLE" ]; then
  echo "BUG ABSENT: target session title is '$TARGET_SEEN_TITLE', expected '$TARGET_TITLE'"
  exit 1
fi

if jq -e --arg id "$TARGET_ID" 'any((.sessions // [])[]; .id == $id)' <<<"$DEFAULT_LIST" >/dev/null; then
  echo "BUG ABSENT: target session is still in the default 50-session list, so the stale off-list hash path is not active"
  exit 1
fi

MESSAGES_JSON="$(curl -fsS "$BASE/api/sessions/$TARGET_ID/messages")"
FIRST_TEXT="$(jq -r '
  first(
    (.messages // [])[].content[]? 
    | select(.type == "text")
    | .text
  ) // empty
' <<<"$MESSAGES_JSON")"

if [ -z "$FIRST_TEXT" ]; then
  echo "BUG ABSENT: target transcript has no text messages to inspect"
  exit 1
fi

if ! grep -Fq 'port flip' <<<"$FIRST_TEXT"; then
  echo "BUG ABSENT: target transcript text no longer matches the worker 4 probe transcript"
  exit 1
fi

HASH_SELECT_ONLY="$(rg -n 'const hash = location.hash.slice\(1\)|if \(hash\) select\(hash\)|try \{ setMessages\(await fetchMessages\(id\)\) \} catch \{\}' "$APP_TSX" || true)"
if ! grep -Fq 'if (hash) select(hash)' <<<"$HASH_SELECT_ONLY"; then
  echo "BUG ABSENT: App.tsx no longer restores the session directly from location.hash"
  exit 1
fi

if ! grep -Fq 'setMessages(await fetchMessages(id))' <<<"$HASH_SELECT_ONLY"; then
  echo "BUG ABSENT: App.tsx no longer fetches messages by the hashed session id"
  exit 1
fi

echo "BUG ABSENT: $BASE keeps $TARGET_ID off the default session list, but the backend still returns the worker 4 probe transcript and App.tsx fetches messages by the exact hashed id instead of switching to another session"
exit 1
