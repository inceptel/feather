#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
SESSION_ID="cb27b0c0-ec00-4df1-8071-f3c6e58ad5d1"
S="replicate-$$"
TEXT='first line second line third line fourth line fifth line sixth line seventh line eighth line ninth line tenth line'

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844
agent-browser --session-name "$S" open "http://localhost:${PORT}/#${SESSION_ID}"
agent-browser --session-name "$S" wait 2500
agent-browser --session-name "$S" fill 'textarea[placeholder="Send a message..."]' "$TEXT"
agent-browser --session-name "$S" wait 500

DETAILS=$(agent-browser --session-name "$S" eval '(() => {
  const el = document.querySelector("textarea[placeholder=\"Send a message...\"]");
  if (!el) return JSON.stringify({ missing: true });
  return JSON.stringify({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    styleHeight: el.style.height,
    valueLength: el.value.length,
    bugPresent: el.scrollHeight > el.clientHeight
  });
})()')

RESULT=$(agent-browser --session-name "$S" eval '(() => {
  const el = document.querySelector("textarea[placeholder=\"Send a message...\"]");
  return String(!!el && el.scrollHeight > el.clientHeight);
})()')

echo "$DETAILS"

if [[ "$RESULT" == "true" || "$RESULT" == "\"true\"" ]]; then
  echo "BUG PRESENT"
  exit 0
fi

echo "BUG ABSENT"
exit 1
