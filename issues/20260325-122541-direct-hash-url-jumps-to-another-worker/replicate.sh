#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

BASE_3304="http://localhost:3304"
TARGET_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
APP="/home/user/feather-dev/w5/frontend/src/App.tsx"
API="/home/user/feather-dev/w5/frontend/src/api.ts"
SERVER="/home/user/feather-dev/w5/server.js"

MESSAGE_COUNT="$(curl -fsS "${BASE_3304}/api/sessions/${TARGET_ID}/messages" | jq '.messages | length')"
SESSION_PRESENT=0
if curl -fsS "${BASE_3304}/api/sessions?limit=500" | jq -e --arg id "${TARGET_ID}" '.sessions[] | select(.id == $id)' >/dev/null; then
  SESSION_PRESENT=1
fi

HASH_RESTORE=0
grep -Fq 'const hash = location.hash.slice(1)' "${APP}" && \
grep -Fq 'if (hash) select(hash)' "${APP}" && \
HASH_RESTORE=1

SAME_ORIGIN_API=0
grep -Fq "const BASE = ''" "${API}" && SAME_ORIGIN_API=1

REDIRECT_CODE=0
if rg -n 'location\.(href|assign|replace)|window\.location|http://localhost:330[0-9]' "${APP}" "${API}" "${SERVER}" >/dev/null; then
  REDIRECT_CODE=1
fi

if [ "${MESSAGE_COUNT}" -gt 0 ] && [ "${HASH_RESTORE}" -eq 1 ] && [ "${SAME_ORIGIN_API}" -eq 1 ] && [ "${REDIRECT_CODE}" -eq 0 ]; then
  echo "BUG ABSENT: worker 4 still serves session ${TARGET_ID} with ${MESSAGE_COUNT} messages, App.tsx restores location.hash via select(hash), api.ts uses same-origin BASE, and no frontend/server redirect-to-other-worker code exists"
  exit 1
fi

echo "BUG PRESENT: target session messages=${MESSAGE_COUNT} listed=${SESSION_PRESENT} hash_restore=${HASH_RESTORE} same_origin_api=${SAME_ORIGIN_API} redirect_code=${REDIRECT_CODE}"
exit 0
