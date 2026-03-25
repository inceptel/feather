#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
S=""

cleanup() {
  if [[ -n "$S" ]]; then
    agent-browser --session-name "$S" close >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

RESULT=""
for attempt in 1 2 3; do
  S="replicate-mobile-rows-$$-$attempt"
  if agent-browser --session-name "$S" set viewport 390 844 >/dev/null 2>&1 &&
     agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null 2>&1 &&
     agent-browser --session-name "$S" wait --load networkidle >/dev/null 2>&1 &&
     agent-browser --session-name "$S" wait 2000 >/dev/null 2>&1 &&
     agent-browser --session-name "$S" eval 'document.querySelector("button")?.click(); true' >/dev/null 2>&1 &&
     agent-browser --session-name "$S" wait 500 >/dev/null 2>&1; then
    RESULT="$(agent-browser --session-name "$S" eval '(() => { const scrollArea = document.querySelector(`div[style*="overflow-y:auto"]`); if (!scrollArea) return JSON.stringify({ error: "session drawer list not found" }); const heights = [...scrollArea.children].map((el) => Math.round(el.getBoundingClientRect().height)); return JSON.stringify({ rowCount: heights.length, minHeight: heights.length ? Math.min(...heights) : 0, bugPresent: heights.length > 0 && heights.some((height) => height < 44) }); })()')"
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
