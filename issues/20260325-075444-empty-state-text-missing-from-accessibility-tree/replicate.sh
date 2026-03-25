#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 2000 >/dev/null

VISIBLE_TEXT="$(agent-browser --session-name "$S" eval '
(() => {
  const bodyText = document.body.innerText || "";
  const hasHeading = bodyText.includes("Select a session");
  const hasInstruction = bodyText.includes("Open a session or create a new one");
  return JSON.stringify({ hasHeading, hasInstruction });
})()
')"

SNAPSHOT="$(agent-browser --session-name "$S" snapshot -i)"

if [[ "$VISIBLE_TEXT" == *'"hasHeading":true'* ]] && \
   [[ "$VISIBLE_TEXT" == *'"hasInstruction":true'* ]] && \
   [[ "$SNAPSHOT" == '- button "☰" [ref='* ]]; then
  echo "BUG PRESENT"
  exit 0
fi

echo "BUG ABSENT"
exit 1
