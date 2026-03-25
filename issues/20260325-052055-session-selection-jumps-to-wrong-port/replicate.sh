#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
S="replicate-$$"
SESSION_TITLE="$(curl -fsS "http://localhost:$PORT/api/sessions" | jq -r '.sessions[0].title')"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ -z "$SESSION_TITLE" ] || [ "$SESSION_TITLE" = "null" ]; then
  echo "No session title available to click"
  exit 1
fi

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null
agent-browser --session-name "$S" wait 2000 >/dev/null

# Repro from the report: open the drawer and tap an existing session from the list.
agent-browser --session-name "$S" eval 'document.querySelector("button")?.click(); true' >/dev/null
agent-browser --session-name "$S" wait 1000 >/dev/null
agent-browser --session-name "$S" find text "$SESSION_TITLE" click >/dev/null
agent-browser --session-name "$S" wait 2500 >/dev/null

RESULT="$(agent-browser --session-name "$S" get url)"
echo "$RESULT"

if [[ "$RESULT" =~ ^http://(localhost|127\.0\.0\.1):([0-9]+)/ ]] && [[ "${BASH_REMATCH[2]}" != "$PORT" ]]; then
  echo "BUG PRESENT"
  exit 0
else
  echo "BUG ABSENT"
  exit 1
fi
