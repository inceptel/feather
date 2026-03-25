#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:${PORT}"
APP="/home/user/feather-dev/w5/frontend/src/App.tsx"
PREFERRED_ID="549bddbd-df9b-46a6-9cc4-13712ad51ad6"

choose_hidden_session() {
  local listed ids session_id
  listed="$(curl -fsS "${BASE}/api/sessions?limit=200" | jq -r '.sessions[].id')"

  if [ -n "${PREFERRED_ID}" ] && ! printf '%s\n' "${listed}" | grep -Fxq "${PREFERRED_ID}"; then
    local preferred_count
    preferred_count="$(curl -fsS "${BASE}/api/sessions/${PREFERRED_ID}/messages" | jq '.messages | length')"
    if [ "${preferred_count}" -gt 0 ]; then
      printf '%s\n' "${PREFERRED_ID}"
      return 0
    fi
  fi

  ids="$(find /home/user/.claude/projects -type f -name '*.jsonl' | sed 's#.*/##; s#\.jsonl$##' | sort -u)"
  while IFS= read -r session_id; do
    [ -n "${session_id}" ] || continue
    if printf '%s\n' "${listed}" | grep -Fxq "${session_id}"; then
      continue
    fi
    local count
    count="$(curl -fsS "${BASE}/api/sessions/${session_id}/messages" | jq '.messages | length')"
    if [ "${count}" -gt 0 ]; then
      printf '%s\n' "${session_id}"
      return 0
    fi
  done <<< "${ids}"

  return 1
}

TARGET_ID="$(choose_hidden_session || true)"
if [ -z "${TARGET_ID}" ]; then
  echo "BUG ABSENT: could not find a hidden session with readable messages"
  exit 1
fi

MESSAGE_COUNT="$(curl -fsS "${BASE}/api/sessions/${TARGET_ID}/messages" | jq '.messages | length')"
LISTED_MATCHES="$(curl -fsS "${BASE}/api/sessions?limit=200" | jq --arg id "${TARGET_ID}" '[.sessions[] | select(.id == $id)] | length')"

HASH_RESTORE_PRESENT=0
grep -Fq 'const hash = location.hash.slice(1)' "${APP}" && HASH_RESTORE_PRESENT=1

SELECT_LOADS_MESSAGES=0
grep -Fq "try { setMessages(await fetchMessages(id)) } catch {}" "${APP}" && SELECT_LOADS_MESSAGES=1

HEADER_ONLY_USES_CUR=0
grep -Fq "fallback={<span style={{ color: '#666', 'font-size': '14px' }}>Select a session</span>}" "${APP}" && \
grep -Fq "const cur = () => sessions().find(s => s.id === currentId())" "${APP}" && HEADER_ONLY_USES_CUR=1

if [ "${MESSAGE_COUNT}" -gt 0 ] && [ "${LISTED_MATCHES}" -eq 0 ] && [ "${HASH_RESTORE_PRESENT}" -eq 1 ] && [ "${SELECT_LOADS_MESSAGES}" -eq 1 ] && [ "${HEADER_ONLY_USES_CUR}" -eq 1 ]; then
  echo "BUG PRESENT: hidden session ${TARGET_ID} has ${MESSAGE_COUNT} messages, /api/sessions omits it, and App.tsx restores currentId from location.hash while the header label only resolves through sessions().find(...)"
  exit 0
fi

echo "BUG ABSENT: target=${TARGET_ID} message_count=${MESSAGE_COUNT} listed_matches=${LISTED_MATCHES} hash_restore=${HASH_RESTORE_PRESENT} select_loads_messages=${SELECT_LOADS_MESSAGES} header_only_uses_cur=${HEADER_ONLY_USES_CUR}"
exit 1
