#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
S="replicate-$$"

cleanup() {
  agent-browser --session "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session "$S" set viewport 390 844 >/dev/null
agent-browser --session "$S" open "http://localhost:$PORT/" >/dev/null
agent-browser --session "$S" wait 2000 >/dev/null

# Repro from the report: open the drawer and tap the existing "hello old friend" session.
agent-browser --session "$S" eval 'document.querySelector("button")?.click(); true' >/dev/null
agent-browser --session "$S" wait 1000 >/dev/null
agent-browser --session "$S" find text "hello old friend" click >/dev/null
agent-browser --session "$S" wait 2500 >/dev/null

RESULT="$(agent-browser --session "$S" get url)"
echo "$RESULT"

if [ "$RESULT" = "http://localhost:3301/" ]; then
  echo "BUG PRESENT"
  exit 0
else
  echo "BUG ABSENT"
  exit 1
fi
