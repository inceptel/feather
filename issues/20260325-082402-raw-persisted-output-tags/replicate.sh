#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
ISSUE_DIR="/home/user/feather-dev/w5/issues/20260325-082402-raw-persisted-output-tags"
TARGET_SESSION="cee9ca45-5a00-420d-a67c-45f205156335"
MESSAGE_VIEW="/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx"

API_JSON="$(curl -fsS "http://localhost:${PORT}/api/sessions/${TARGET_SESSION}/messages")"

if printf '%s' "$API_JSON" | node -e '
const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const messages = Array.isArray(payload.messages) ? payload.messages : [];
const leaked = messages.some((message) =>
  Array.isArray(message.content) &&
  message.content.some((block) =>
    block &&
    block.type === "tool_result" &&
    typeof block.content === "string" &&
    block.content.includes("<persisted-output>")
  )
);
process.exit(leaked ? 0 : 1);
' && \
  grep -Fq "const raw = typeof block.content === 'string' ? block.content" "$MESSAGE_VIEW" && \
  grep -Fq "const preview = raw.slice(0, 200)" "$MESSAGE_VIEW"
then
  echo "BUG PRESENT: persisted-output tag is stored in session ${TARGET_SESSION} and MessageView renders raw tool_result preview text"
  exit 0
fi

echo "BUG ABSENT"
exit 1
