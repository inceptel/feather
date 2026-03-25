#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
BASE="http://localhost:$PORT"
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

TARGET_ID="$(
  curl -fsS "$BASE/api/sessions" |
    jq -r 'first((.sessions // [])[] | select(.isActive == false) | .id) // empty'
)"

if [ -z "$TARGET_ID" ]; then
  echo "BUG ABSENT: no inactive session was available to resume"
  exit 1
fi

BEFORE_ACTIVE="$(
  curl -fsS "$BASE/api/sessions" |
    jq -r --arg id "$TARGET_ID" 'first((.sessions // [])[] | select(.id == $id) | if .isActive then "true" else "false" end) // "missing"'
)"

if [ "$BEFORE_ACTIVE" != "false" ]; then
  echo "BUG ABSENT: target session $TARGET_ID was not inactive before resume ($BEFORE_ACTIVE)"
  exit 1
fi

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "$BASE/#$TARGET_ID" >/dev/null
agent-browser --session-name "$S" wait 2500 >/dev/null

BEFORE_SNAPSHOT="$(mktemp)"
AFTER_SNAPSHOT="$(mktemp)"

agent-browser --session-name "$S" snapshot >"$BEFORE_SNAPSHOT"
if ! rg -F 'button "Resume"' "$BEFORE_SNAPSHOT" >/dev/null; then
  echo "BUG ABSENT: inactive session did not expose a Resume button in the header"
  exit 1
fi

agent-browser --session-name "$S" find role button click --name "Resume" >/dev/null
agent-browser --session-name "$S" wait 800 >/dev/null
agent-browser --session-name "$S" snapshot >"$AFTER_SNAPSHOT"

if rg -F 'button "Resume"' "$AFTER_SNAPSHOT" >/dev/null; then
  echo "BUG ABSENT: clicking Resume did not switch the UI into the resumed header state"
  exit 1
fi

sleep 3
AFTER_ACTIVE="$(
  curl -fsS "$BASE/api/sessions" |
    jq -r --arg id "$TARGET_ID" 'first((.sessions // [])[] | select(.id == $id) | if .isActive then "true" else "false" end) // "missing"'
)"

if [ "$AFTER_ACTIVE" = "false" ]; then
  echo "BUG PRESENT: UI hid Resume for $TARGET_ID, but /api/sessions still reports isActive=false after resume"
  exit 0
fi

echo "BUG ABSENT: /api/sessions persisted isActive=$AFTER_ACTIVE for $TARGET_ID after resume"
exit 1
