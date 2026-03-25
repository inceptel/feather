#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:${PORT}"
ISSUE_DIR="/home/user/feather-dev/w5/issues/20260325-080856-ansi-escape-codes-visible-in-output"
MESSAGE_VIEW="/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx"

if ! command -v jq >/dev/null 2>&1; then
  echo "BUG ABSENT: jq is required for this reproduction script"
  exit 1
fi

SESSIONS_JSON="$(curl -fsS "${BASE}/api/sessions?limit=50")"
TARGET_SESSION_ID=""
TARGET_SESSION_TITLE=""
TARGET_PREVIEW=""

for session_id in $(printf '%s' "${SESSIONS_JSON}" | jq -r '.sessions[]?.id'); do
  MESSAGES_JSON="$(curl -fsS "${BASE}/api/sessions/${session_id}/messages?limit=200")"
  MATCH="$(printf '%s' "${MESSAGES_JSON}" | jq -r '
    first(
      .messages[]?.content[]?
      | select(.type == "tool_result")
      | if (.content | type) == "string" then .content
        elif (.content | type) == "array" then (.content | map(.text // "") | join(""))
        else ""
        end
      | select(test("\u001b\\[[0-9;]*m"))
    ) // empty
  ')"
  if [ -n "${MATCH}" ]; then
    TARGET_SESSION_ID="${session_id}"
    TARGET_SESSION_TITLE="$(printf '%s' "${SESSIONS_JSON}" | jq -r --arg id "${session_id}" 'first(.sessions[] | select(.id == $id) | .title)')"
    TARGET_PREVIEW="$(printf '%s' "${MATCH}" | head -c 160 | tr '\n' ' ')"
    break
  fi
done

if [ -z "${TARGET_SESSION_ID}" ]; then
  echo "BUG ABSENT: no currently listed session exposed ANSI escape codes in /api/sessions/*/messages"
  exit 1
fi

if ! grep -Fq "const raw = typeof block.content === 'string'" "${MESSAGE_VIEW}"; then
  echo "BUG ABSENT: MessageView no longer reads raw tool_result content directly"
  exit 1
fi

if ! grep -Fq "{preview && <div" "${MESSAGE_VIEW}"; then
  echo "BUG ABSENT: MessageView no longer renders the preview block for tool_result content"
  exit 1
fi

printf 'BUG PRESENT: session %s ("%s") still exposes ANSI escapes in tool_result content, for example: %s\n' \
  "${TARGET_SESSION_ID}" "${TARGET_SESSION_TITLE}" "${TARGET_PREVIEW}"
exit 0
