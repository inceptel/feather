#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:$PORT"
TARGET_TITLE="worker 4 probe"
S="replicate-attach-label-$$"

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

RESULT="$(agent-browser --session-name "$S" eval 'JSON.stringify((() => {
  const button = [...document.querySelectorAll("button")].find((el) => {
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && (el.getAttribute("title") || "").trim() === "Attach file"
  })
  if (!button) return { found: false }

  const text = (button.textContent || "").trim()
  const ariaLabel = (button.getAttribute("aria-label") || "").trim()
  const ariaLabelledby = (button.getAttribute("aria-labelledby") || "").trim()

  return {
    found: true,
    text,
    ariaLabel,
    ariaLabelledby,
    bugPresent: text === "+" && ariaLabel === "" && ariaLabelledby === ""
  }
})())')"

FOUND="$(printf '%s' "$RESULT" | jq -r 'fromjson | .found')"
BUG_PRESENT="$(printf '%s' "$RESULT" | jq -r 'fromjson | .bugPresent // false')"
TEXT_VALUE="$(printf '%s' "$RESULT" | jq -r 'fromjson | .text // ""')"
ARIA_LABEL="$(printf '%s' "$RESULT" | jq -r 'fromjson | .ariaLabel // ""')"
ARIA_LABELLEDBY="$(printf '%s' "$RESULT" | jq -r 'fromjson | .ariaLabelledby // ""')"

if [ "$FOUND" != "true" ]; then
  echo "BUG ABSENT: could not find a visible attach button in the chat composer"
  exit 1
fi

if [ "$BUG_PRESENT" = "true" ]; then
  echo "BUG PRESENT: attach control is exposed as '$TEXT_VALUE' with no aria-label or aria-labelledby"
  exit 0
fi

echo "BUG ABSENT: attach control has text '$TEXT_VALUE', aria-label '$ARIA_LABEL', aria-labelledby '$ARIA_LABELLEDBY'"
exit 1
