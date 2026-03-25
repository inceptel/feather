#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:${PORT}"
TARGET_SESSION="4baa1292-7fdf-4e87-af47-6731e459b3cd"
TARGET_PATH="/home/user/feather-aw/w4/after-send-iter27.png"
MESSAGE_VIEW="/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx"

API_JSON="$(curl -fsS "${BASE}/api/sessions/${TARGET_SESSION}/messages?limit=500")"

if ! printf '%s' "${API_JSON}" | node -e '
const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const messages = Array.isArray(payload.messages) ? payload.messages : [];

let found = false;
for (let i = 0; i < messages.length - 1; i += 1) {
  const current = messages[i];
  const next = messages[i + 1];
  const hasTargetRead = Array.isArray(current.content) && current.content.some((block) =>
    block &&
    block.type === "tool_use" &&
    block.name === "Read" &&
    block.input &&
    block.input.file_path === process.argv[1]
  );
  if (!hasTargetRead) continue;

  const imageOnlyResult = Array.isArray(next?.content) && next.content.some((block) => {
    if (!block || block.type !== "tool_result" || !Array.isArray(block.content)) return false;
    const parts = block.content;
    const hasImage = parts.some((part) => part && part.type === "image" && part.source && part.source.media_type === "image/png");
    const visibleText = parts.map((part) => typeof part?.text === "string" ? part.text.trim() : "").join("");
    return hasImage && visibleText.length === 0;
  });

  if (hasTargetRead && imageOnlyResult) {
    found = true;
    break;
  }
}

process.exit(found ? 0 : 1);
' "${TARGET_PATH}"
then
  echo "BUG ABSENT: target session no longer stores an image-only tool_result after reading ${TARGET_PATH}"
  exit 1
fi

if ! grep -Fq "const raw = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((c: any) => c.text || '').join('') : ''" "${MESSAGE_VIEW}"; then
  echo "BUG ABSENT: MessageView tool_result extraction no longer drops non-text payload parts"
  exit 1
fi

if ! grep -Fq "{preview && <div" "${MESSAGE_VIEW}"; then
  echo "BUG ABSENT: MessageView no longer hides the output body when preview text is empty"
  exit 1
fi

echo "BUG PRESENT: ${TARGET_SESSION} stores an image/png tool_result for ${TARGET_PATH}, and MessageView still derives tool_result preview text only from .text fields so the OUTPUT card body renders empty"
exit 0
