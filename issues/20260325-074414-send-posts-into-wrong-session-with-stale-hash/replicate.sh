#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
BASE="http://localhost:${PORT}"
TARGET_ID="4baa1292-7fdf-4e87-af47-6731e459b3cd"
TARGET_TITLE="worker 4 probe"
PROBE="worker5 stale-hash send probe $(date -u +%s%N)"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"
TARGET_JSONL="/home/user/.claude/projects/-home-user/${TARGET_ID}.jsonl"

DEFAULT_LIST="$(curl -fsS "${BASE}/api/sessions")"

if [ ! -f "$TARGET_JSONL" ]; then
  echo "BUG ABSENT: target foreign session JSONL ${TARGET_JSONL} is no longer present on disk"
  exit 1
fi

if jq -e --arg id "$TARGET_ID" 'any((.sessions // [])[]; .id == $id)' >/dev/null <<<"$DEFAULT_LIST"; then
  echo "BUG ABSENT: target foreign session ${TARGET_ID} is still in the default visible session list"
  exit 1
fi

TARGET_FIRST_TEXT="$(curl -fsS "${BASE}/api/sessions/${TARGET_ID}/messages" | jq -r '
  first((.messages // [])[].content[]? | select(.type == "text") | .text) // empty
')"
if ! grep -Fq 'port flip' <<<"$TARGET_FIRST_TEXT"; then
  echo "BUG ABSENT: target transcript no longer matches the worker 4 stale-hash probe conversation"
  exit 1
fi

HASH_RESTORE="$(rg -n 'const hash = location.hash.slice\(1\)|if \(hash\) select\(hash\)' "$APP_TSX" || true)"
VISIBLE_LOOKUP="$(rg -n 'const cur = \(\) => sessions\(\)\.find\(s => s\.id === currentId\(\)\)' "$APP_TSX" || true)"
SEND_PATH="$(rg -n 'if \(\(!val && !pending.length\) \|\| !currentId\(\)\) return|sendInput\(currentId\(\)!, fullText\)' "$APP_TSX" || true)"

if [ -z "$HASH_RESTORE" ] || [ -z "$VISIBLE_LOOKUP" ] || [ -z "$SEND_PATH" ]; then
  echo "BUG ABSENT: App.tsx no longer restores hidden hashes and sends using the stale currentId path"
  exit 1
fi

BEFORE_COUNT="$(curl -fsS "${BASE}/api/sessions/${TARGET_ID}/messages?limit=200" | jq --arg probe "$PROBE" '
  [(.messages // [])[] | .content[]? | select(.type == "text" and .text == $probe)] | length
')"

curl -fsS -X POST "${BASE}/api/sessions/${TARGET_ID}/send" \
  -H 'Content-Type: application/json' \
  --data "$(jq -cn --arg text "$PROBE" '{text: $text}')" >/dev/null

FOUND=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  AFTER_COUNT="$(curl -fsS "${BASE}/api/sessions/${TARGET_ID}/messages?limit=200" | jq --arg probe "$PROBE" '
    [(.messages // [])[] | .content[]? | select(.type == "text" and .text == $probe)] | length
  ')"
  if [ "$AFTER_COUNT" -gt "$BEFORE_COUNT" ]; then
    FOUND=1
    break
  fi
  sleep 1
done

if [ "$FOUND" -ne 1 ]; then
  echo "BUG ABSENT: probe send did not land in hidden session ${TARGET_ID}"
  exit 1
fi

echo "BUG PRESENT: ${BASE} still keeps ${TARGET_ID} off the visible list, App.tsx restores and sends via the stale hash/currentId path, and a probe message lands in the hidden worker 4 transcript"
exit 0
