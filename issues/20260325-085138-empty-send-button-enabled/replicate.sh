#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
SESSION_ID="70fd21d1-cd91-406c-8ab6-a83785c0fc2e"
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://localhost:$PORT/#$SESSION_ID" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 2000 >/dev/null

STATE=$(
  agent-browser --session-name "$S" eval '(() => {
    const textarea = document.querySelector("textarea[placeholder=\"Send a message...\"]");
    const button = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent && candidate.textContent.trim() === "Send"
    );
    const bugPresent = Boolean(textarea) &&
      Boolean(button) &&
      textarea.value.trim() === "" &&
      !button.disabled;
    return bugPresent ? "bug-present" : "bug-absent";
  })()'
)

if [ "$STATE" = '"bug-present"' ]; then
  echo "BUG PRESENT: empty composer still leaves Send enabled"
  exit 0
fi

echo "BUG ABSENT: $STATE"
exit 1
