#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:${PORT}"
TARGET_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
MESSAGE_VIEW="/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx"

MESSAGES_JSON="$(curl -fsS "${BASE}/api/sessions/${TARGET_ID}/messages?limit=200")"
MESSAGE_COUNT="$(printf '%s' "${MESSAGES_JSON}" | jq '.messages | length')"
TIMESTAMPED_COUNT="$(printf '%s' "${MESSAGES_JSON}" | jq '[.messages[] | select((.timestamp // "") != "")] | length')"

if [ "${MESSAGE_COUNT}" -lt 2 ] || [ "${TIMESTAMPED_COUNT}" -lt 2 ]; then
  echo "BUG ABSENT: target session ${TARGET_ID} is not available with timestamped messages at ${BASE}"
  exit 1
fi

TIMESTAMP_RENDER_LINE="<span style={{ 'font-size': '10px', color: '#444' }}>{formatTime(msg.timestamp)}</span>"

if ! grep -Fq "${TIMESTAMP_RENDER_LINE}" "${MESSAGE_VIEW}"; then
  echo "BUG ABSENT: ${MESSAGE_VIEW} no longer renders timestamps as a plain span"
  exit 1
fi

TIME_ELEMENT_REFERENCES="$(rg -n "<time|datetime=|aria-label=.*formatTime|role=.*time" "${MESSAGE_VIEW}" || true)"
if [ -n "${TIME_ELEMENT_REFERENCES}" ]; then
  echo "BUG ABSENT: ${MESSAGE_VIEW} now appears to attach time semantics"
  exit 1
fi

SAMPLED_TIMESTAMPS="$(printf '%s' "${MESSAGES_JSON}" | jq -r '[.messages[] | .timestamp][0:5] | map(split("T")[1][0:5]) | join(", ")')"

if [ "${MESSAGE_COUNT}" -ge 2 ] && [ "${TIMESTAMPED_COUNT}" -ge 2 ]; then
  echo "BUG PRESENT: session ${TARGET_ID} still has ${TIMESTAMPED_COUNT} timestamped messages (${SAMPLED_TIMESTAMPS}) and ${MESSAGE_VIEW} renders formatTime(msg.timestamp) inside a plain span with no semantic time markup"
  exit 0
fi

echo "BUG ABSENT: timestamp semantics are now exposed"
exit 1
