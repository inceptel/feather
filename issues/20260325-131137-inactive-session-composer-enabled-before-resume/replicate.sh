#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE_URL="http://localhost:${PORT}"

SESSION_ID="$(
  curl -fsS "${BASE_URL}/api/sessions" \
    | jq -r '.sessions[] | select(.isActive == false) | .id' \
    | head -n 1
)"

if [ -z "${SESSION_ID}" ]; then
  echo "BUG ABSENT: no inactive session available"
  exit 1
fi

STILL_INACTIVE="$(
  curl -fsS "${BASE_URL}/api/sessions" \
    | jq -e --arg id "${SESSION_ID}" '.sessions[] | select(.id == $id and .isActive == false) | true' \
    || true
)"

if [ "${STILL_INACTIVE}" != "true" ]; then
  echo "BUG ABSENT: selected session is not inactive"
  exit 1
fi

S="replicate-$$"
cleanup() {
  agent-browser --session-name "${S}" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "${S}" set viewport 390 844 >/dev/null
agent-browser --session-name "${S}" open "${BASE_URL}/#${SESSION_ID}" >/dev/null
agent-browser --session-name "${S}" wait --load networkidle >/dev/null
agent-browser --session-name "${S}" wait 2000 >/dev/null

RESULT="$(
  agent-browser --session-name "${S}" eval "$(cat <<'EOF'
(() => {
  const buttons = [...document.querySelectorAll('button')]
  const resume = buttons.find((button) => button.textContent.trim() === 'Resume')
  const attach = buttons.find((button) => button.textContent.trim() === '+')
  const send = buttons.find((button) => button.textContent.trim() === 'Send')
  const textarea = document.querySelector('textarea[placeholder="Send a message..."]')

  return JSON.stringify({
    hasResume: Boolean(resume),
    textareaEnabled: Boolean(textarea) && !textarea.disabled,
    attachEnabled: Boolean(attach) && !attach.disabled,
    sendEnabled: Boolean(send) && !send.disabled,
  })
})()
EOF
)"
)"

NORMALIZED="$(
  printf '%s' "${RESULT}" | jq -r 'fromjson | [.hasResume, .textareaEnabled, .attachEnabled, .sendEnabled] | all'
)"

if [ "${NORMALIZED}" = "true" ]; then
  echo "BUG PRESENT"
  exit 0
fi

echo "BUG ABSENT: ${RESULT}"
exit 1
