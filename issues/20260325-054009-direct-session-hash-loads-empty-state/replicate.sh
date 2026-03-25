#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
TARGET_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
TARGET_TITLE="hello old friend"
EXPECTED_ORIGIN="http://localhost:$PORT"
S=""

cleanup() {
  if [[ -n "$S" ]]; then
    agent-browser --session-name "$S" close >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

API_STATE="$(curl -sf "$EXPECTED_ORIGIN/api/sessions")"
if [[ "$API_STATE" != *"\"id\":\"$TARGET_ID\""* ]] || [[ "$API_STATE" != *"\"title\":\"$TARGET_TITLE\""* ]]; then
  echo "BUG ABSENT: target session is unavailable from $EXPECTED_ORIGIN/api/sessions"
  exit 1
fi

RESULT=""
for attempt in 1 2 3; do
  S="replicate-direct-hash-$$-$attempt"
  if agent-browser --session-name "$S" set viewport 390 844 >/dev/null 2>&1 &&
     agent-browser --session-name "$S" open "$EXPECTED_ORIGIN/#$TARGET_ID" >/dev/null 2>&1 &&
     agent-browser --session-name "$S" wait 3000 >/dev/null 2>&1; then
    RESULT="$(agent-browser --session-name "$S" eval '(() => {
      const targetId = "'"$TARGET_ID"'";
      const expectedOrigin = "'"$EXPECTED_ORIGIN"'";
      const bodyText = document.body.innerText || "";
      const hasEmptyState =
        bodyText.includes("Select a session") ||
        bodyText.includes("Open a session or create a new one");
      const href = location.href;
      const bugPresent =
        href !== `${expectedOrigin}/#${targetId}` &&
        hasEmptyState;
      return JSON.stringify({
        href,
        hasEmptyState,
        bodySnippet: bodyText.slice(0, 160),
        bugPresent
      });
    })()')"
    break
  fi
  cleanup
  S=""
  sleep 2
done

if [[ -z "$RESULT" ]]; then
  echo "BUG ABSENT: failed to launch browser session after 3 attempts"
  exit 1
fi

NORMALIZED_RESULT="$(printf '%s' "$RESULT" | tr -d '\\')"

if [[ "$NORMALIZED_RESULT" == *'"bugPresent":true'* ]]; then
  echo "BUG PRESENT: $NORMALIZED_RESULT"
  exit 0
fi

echo "BUG ABSENT: $NORMALIZED_RESULT"
exit 1
