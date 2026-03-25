#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
SESSION_ID="370e2f60-1399-4ebf-a182-7a8ba6c59ccf"
PROBE_TEXT="w5 repro probe 1774438929"
TARGET_TEXT="(Bash completed with no output)"
SOURCE_FILE="/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx"
NODE_PATH="${NODE_PATH:-/home/user/feather/node_modules}"

API_JSON="$(curl -fsS "http://localhost:${PORT}/api/sessions/${SESSION_ID}/messages?limit=500")"

if ! printf '%s' "${API_JSON}" | node -e '
const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const messages = Array.isArray(payload.messages) ? payload.messages : [];

const probeIndex = messages.findIndex((message) =>
  message &&
  message.role === "user" &&
  Array.isArray(message.content) &&
  message.content.some((block) => block && block.type === "text" && typeof block.text === "string" && block.text.includes(process.argv[1]))
);

if (probeIndex === -1) process.exit(1);

const nearbyUserToolResult = messages
  .slice(probeIndex + 1, probeIndex + 8)
  .some((message) =>
    message &&
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((block) => {
      if (!block || block.type !== "tool_result") return false;
      const raw = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((part) => part && typeof part.text === "string" ? part.text : "").join("")
          : "";
      return raw.includes(process.argv[2]);
    })
  );

process.exit(nearbyUserToolResult ? 0 : 1);
' "${PROBE_TEXT}" "${TARGET_TEXT}"
then
  echo "BUG ABSENT: target probe exchange is no longer stored as a user-authored tool_result sequence"
  exit 1
fi

if ! SOURCE_FILE="${SOURCE_FILE}" node - <<'NODE'
const fs = require('fs');

const source = fs.readFileSync(process.env.SOURCE_FILE, 'utf8');
const alignsUserMessagesRight = source.includes("'align-items': msg.role === 'user' ? 'flex-end' : 'flex-start'");
const keepsUserBubbleStyling = source.includes("background: msg.role === 'user' ? 'rgba(74,186,106,0.15)' : '#1a1a2e'");
const toolResultHasNoRoleOverride =
  source.includes("if (block.type === 'tool_result') {") &&
  !source.includes("block.type === 'tool_result' && msg.role !== 'user'");

process.exit(alignsUserMessagesRight && keepsUserBubbleStyling && toolResultHasNoRoleOverride ? 0 : 1);
NODE
then
  echo "BUG ABSENT: MessageView no longer styles tool_result cards through the generic user bubble wrapper"
  exit 1
fi

printf '%s' "${API_JSON}" | node -e '
const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const messages = Array.isArray(payload.messages) ? payload.messages : [];

const probeIndex = messages.findIndex((message) =>
  message &&
  message.role === "user" &&
  Array.isArray(message.content) &&
  message.content.some((block) => block && block.type === "text" && typeof block.text === "string" && block.text.includes(process.argv[1]))
);

const matching = probeIndex === -1 ? [] : messages
  .slice(probeIndex + 1, probeIndex + 8)
  .filter((message) =>
    message &&
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((block) => {
      if (!block || block.type !== "tool_result") return false;
      const raw = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((part) => part && typeof part.text === "string" ? part.text : "").join("")
          : "";
      return raw.includes(process.argv[2]);
    })
  )
  .map((message) => ({ uuid: message.uuid, timestamp: message.timestamp, role: message.role }));

const bugPresent = probeIndex !== -1 && matching.length > 0;
console.log(JSON.stringify({ probeIndex, matching, bugPresent }, null, 2));
process.exit(bugPresent ? 0 : 1);
' "${PROBE_TEXT}" "${TARGET_TEXT}"
