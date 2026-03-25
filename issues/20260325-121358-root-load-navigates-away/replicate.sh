#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
BASE="http://localhost:${PORT}"
ISSUE_DIR="/home/user/feather-dev/w5/issues/20260325-121358-root-load-navigates-away"
APP_TSX="/home/user/feather-dev/w5/frontend/src/App.tsx"
API_TS="/home/user/feather-dev/w5/frontend/src/api.ts"
SERVER_JS="/home/user/feather-dev/w5/server.js"

ROOT_HTML="$(curl -fsS "${BASE}/")"
SESSIONS_JSON="$(curl -fsS "${BASE}/api/sessions")"

if ! grep -Fq '<div id="root"></div>' <<<"$ROOT_HTML"; then
  echo "BUG PRESENT: ${BASE}/ did not return the Feather SPA shell"
  exit 0
fi

if grep -Eqi '<meta[^>]+http-equiv=["'"'"']refresh["'"'"']' <<<"$ROOT_HTML"; then
  echo "BUG PRESENT: ${BASE}/ contains a meta refresh redirect"
  exit 0
fi

if ! grep -Fq '"sessions"' <<<"$SESSIONS_JSON"; then
  echo "BUG PRESENT: ${BASE}/api/sessions did not return the sessions payload"
  exit 0
fi

if ! grep -Fq "const BASE = ''" "$API_TS"; then
  echo "BUG PRESENT: frontend API base is no longer relative"
  exit 0
fi

if ! grep -Fq "const hash = location.hash.slice(1)" "$APP_TSX"; then
  echo "BUG PRESENT: root mount no longer restores from the current hash only"
  exit 0
fi

if ! grep -Fq "if (hash) select(hash)" "$APP_TSX"; then
  echo "BUG PRESENT: root mount gained additional startup selection logic"
  exit 0
fi

if grep -Eq 'location\.(assign|replace|href)|window\.location|window\.open' "$APP_TSX"; then
  echo "BUG PRESENT: App.tsx contains an explicit navigation primitive"
  exit 0
fi

if grep -Eq 'res\.redirect|location\.(assign|replace)|window\.location' "$SERVER_JS"; then
  echo "BUG PRESENT: server.js contains redirect logic"
  exit 0
fi

echo "BUG ABSENT: ${BASE}/ serves the SPA shell, the API stays same-origin, App.tsx only restores location.hash on mount, and neither App.tsx nor server.js contains root-load redirect logic"
exit 1
