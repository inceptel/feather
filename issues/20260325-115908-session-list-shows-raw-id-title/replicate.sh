#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:${PORT}"
PROJECT_DIR="/home/user/.claude/projects/-home-user"
SESSION_ID="1cb410df-0000-4000-8000-000000000000"
SESSION_FILE="${PROJECT_DIR}/${SESSION_ID}.jsonl"
RAW_TITLE="${SESSION_ID%%-*}"

mkdir -p "${PROJECT_DIR}"

# Seed a valid transcript that lacks any qualifying non-meta user message.
# discoverSessions() then falls back to id.slice(0, 8), which the drawer renders directly.
printf '%s\n' '{"type":"assistant","message":{"content":"bootstrap only"}}' > "${SESSION_FILE}"

for _ in 1 2 3 4 5; do
  SESSION_JSON="$(curl -fsS "${BASE}/api/sessions?limit=20" | jq -c --arg id "${SESSION_ID}" 'first((.sessions // [])[] | select(.id == $id)) // empty')"
  if [ -n "${SESSION_JSON}" ]; then
    break
  fi
  sleep 1
done

if [ -z "${SESSION_JSON:-}" ]; then
  echo "BUG ABSENT: seeded session ${SESSION_ID} did not appear in ${BASE}/api/sessions"
  exit 1
fi

TITLE="$(printf '%s' "${SESSION_JSON}" | jq -r '.title // empty')"
MATCHES_RAW_ID="$(printf '%s' "${SESSION_JSON}" | jq -r --arg raw "${RAW_TITLE}" 'if .title == $raw then "true" else "false" end')"

if [ "${MATCHES_RAW_ID}" = "true" ]; then
  echo "BUG PRESENT: ${BASE}/api/sessions reports title '${TITLE}' for ${SESSION_ID}, exposing the raw internal id prefix that App.tsx renders in the session drawer"
  exit 0
fi

echo "BUG ABSENT: seeded session title resolved to '${TITLE}' instead of raw id prefix '${RAW_TITLE}'"
exit 1
