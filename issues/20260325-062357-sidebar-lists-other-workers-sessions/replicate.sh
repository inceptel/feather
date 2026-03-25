#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
BASE="http://localhost:$PORT"
SERVER_JS="/home/user/feather-dev/w5/server.js"

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "BUG ABSENT: invalid PORT '$PORT'"
  exit 1
fi

OWN_WORKER_NUM="${WORKER_NUM:-$((PORT - 3300))}"
OWN_PREFIX="WORKER_NUM=${OWN_WORKER_NUM} "

SESSIONS_JSON="$(curl -fsS "$BASE/api/sessions?limit=50")"
FOREIGN_TITLES="$(printf '%s' "$SESSIONS_JSON" | jq -r --arg own "$OWN_PREFIX" '
  (.sessions // [])
  | map(.title // "")
  | map(select(startswith("WORKER_NUM=") and (startswith($own) | not)))
  | unique
  | .[]
')"

if [ -z "$FOREIGN_TITLES" ]; then
  echo "BUG ABSENT: /api/sessions only returned local worker titles for worker $OWN_WORKER_NUM"
  exit 1
fi

DISCOVERS_ALL_PROJECTS="$(rg -n "for \\(const dir of fs\\.readdirSync\\(CLAUDE_PROJECTS\\)\\)" "$SERVER_JS" || true)"
UNFILTERED_ROUTE="$(rg -n "res\\.json\\(\\{ sessions: discoverSessions\\(parseInt\\(req\\.query\\.limit\\) \\|\\| 50\\) \\}\\)" "$SERVER_JS" || true)"

if [ -n "$DISCOVERS_ALL_PROJECTS" ] && [ -n "$UNFILTERED_ROUTE" ]; then
  echo "BUG PRESENT: worker $OWN_WORKER_NUM leaked foreign sessions:"
  printf '%s\n' "$FOREIGN_TITLES"
  exit 0
fi

echo "BUG ABSENT: foreign sessions were returned, but the current server source no longer matches the unfiltered discovery path"
exit 1
