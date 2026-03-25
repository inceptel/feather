#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
BASE="http://localhost:$PORT"
SERVER_JS="/home/user/feather-dev/w5/server.js"

SESSIONS_JSON="$(curl -fsS "$BASE/api/sessions?limit=50")"

DUPLICATE_RAW_TITLES="$(printf '%s' "$SESSIONS_JSON" | jq -r '
  (.sessions // [])
  | map(.title // "")
  | map(select(startswith("WORKER_NUM=")))
  | sort
  | group_by(.)
  | map(select(length >= 2) | { title: .[0], count: length })
  | .[]
  | "\(.count)\t\(.title)"
')"

if [ -z "$DUPLICATE_RAW_TITLES" ]; then
  echo "BUG ABSENT: /api/sessions did not expose repeated raw WORKER_NUM bootstrap titles"
  exit 1
fi

TITLE_FROM_FIRST_USER_MESSAGE="$(rg -n -F 'title = text.slice(0, 80);' "$SERVER_JS" || true)"
SESSION_LIST_RETURNS_DISCOVERY="$(rg -n -F 'res.json({ sessions: discoverSessions(parseInt(req.query.limit) || 50) });' "$SERVER_JS" || true)"

if [ -z "$TITLE_FROM_FIRST_USER_MESSAGE" ] || [ -z "$SESSION_LIST_RETURNS_DISCOVERY" ]; then
  echo "BUG ABSENT: duplicate raw titles exist in data, but current server source no longer matches the title extraction path"
  exit 1
fi

echo "BUG PRESENT: /api/sessions exposes indistinguishable raw bootstrap titles that the mobile drawer renders verbatim"
printf '%s\n' "$DUPLICATE_RAW_TITLES"
exit 0
