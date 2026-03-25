#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

session_count() {
  curl -s "http://localhost:$PORT/api/sessions" | node -e '
let data = "";
process.stdin.on("data", (chunk) => data += chunk);
process.stdin.on("end", () => {
  const parsed = JSON.parse(data);
  console.log(parsed.sessions.length);
});
'
}

session_exists() {
  local id="$1"
  curl -s "http://localhost:$PORT/api/sessions" | node -e '
let data = "";
process.stdin.on("data", (chunk) => data += chunk);
process.stdin.on("end", () => {
  const parsed = JSON.parse(data);
  const found = parsed.sessions.some((session) => session.id === process.argv[1]);
  console.log(found ? "yes" : "no");
});
' "$id"
}

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 1500 >/dev/null

BEFORE_COUNT="$(session_count)"

agent-browser --session-name "$S" find role button click --name "☰" >/dev/null
agent-browser --session-name "$S" wait 800 >/dev/null
agent-browser --session-name "$S" find role button click --name "+ New Claude" >/dev/null
agent-browser --session-name "$S" wait 5000 >/dev/null

URL="$(agent-browser --session-name "$S" get url | tail -n 1)"
AFTER_COUNT="$(session_count)"

if [[ "$URL" != http://localhost:$PORT/* ]]; then
  echo "BUG PRESENT: left worker URL ($URL)"
  exit 0
fi

HASH_ID="${URL##*#}"
if [[ "$HASH_ID" == "$URL" || -z "$HASH_ID" ]]; then
  echo "BUG ABSENT: no new-session hash was set"
  exit 1
fi

FOUND="$(session_exists "$HASH_ID")"
if [[ "$FOUND" != "yes" && "$AFTER_COUNT" -le "$BEFORE_COUNT" ]]; then
  echo "BUG PRESENT: navigated to missing session id $HASH_ID without creating a session"
  exit 0
fi

echo "BUG ABSENT: session $HASH_ID exists and session count increased ($BEFORE_COUNT -> $AFTER_COUNT)"
exit 1
