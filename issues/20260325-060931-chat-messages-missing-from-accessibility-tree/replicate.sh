#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:$PORT"
TARGET_TITLE="worker 4 probe"
S="replicate-chat-a11y-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

TARGET_ID="$(curl -fsS "$BASE/api/sessions?limit=500" | jq -r --arg title "$TARGET_TITLE" 'first((.sessions // [])[] | select(.title == $title) | .id) // empty')"

if [ -z "$TARGET_ID" ]; then
  echo "BUG ABSENT: could not find session titled '$TARGET_TITLE' at $BASE/api/sessions"
  exit 1
fi

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "$BASE/#$TARGET_ID" >/dev/null
agent-browser --session-name "$S" wait 3000 >/dev/null

SNAPSHOT="$(agent-browser --session-name "$S" snapshot -i)"
VISIBLE_MARKDOWN="$(agent-browser --session-name "$S" eval 'JSON.stringify((() => [...document.querySelectorAll(".markdown")].map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()).filter((text) => text.length >= 40).slice(0, 8))())')"

VISIBLE_COUNT="$(printf '%s' "$VISIBLE_MARKDOWN" | jq 'fromjson | length')"

if [ "$VISIBLE_COUNT" -eq 0 ]; then
  echo "BUG ABSENT: no visible transcript markdown found in DOM"
  exit 1
fi

MISSING_COUNT=0
FIRST_MISSING=""
while IFS= read -r sample; do
  short="$(printf '%s' "$sample" | cut -c1-80)"
  if ! printf '%s' "$SNAPSHOT" | grep -Fq "$short"; then
    MISSING_COUNT=$((MISSING_COUNT + 1))
    if [ -z "$FIRST_MISSING" ]; then
      FIRST_MISSING="$short"
    fi
  fi
done < <(printf '%s' "$VISIBLE_MARKDOWN" | jq -r 'fromjson | .[]')

if [ "$MISSING_COUNT" -gt 0 ]; then
  echo "BUG PRESENT: $MISSING_COUNT of $VISIBLE_COUNT visible transcript snippets are missing from the accessibility snapshot"
  echo "Example missing snippet: $FIRST_MISSING"
  exit 0
fi

echo "BUG ABSENT: accessibility snapshot exposed all sampled visible transcript snippets"
exit 1
