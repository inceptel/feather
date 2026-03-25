#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
BASE="http://localhost:$PORT"
APP_TSX="/home/user/feather-dev/w5/frontend/src/components/MessageView.tsx"
SESSION_ID="replicate-mobile-tool-output-nested-scroll"
SESSION_TITLE="mobile tool output nested scroll probe"
SESSION_UUID_PREFIX="mobile-tool-output-nested-scroll"
PROJECT_DIR="$(find "${HOME:-/home/user}/.claude/projects" -mindepth 1 -maxdepth 1 -type d | head -n1)"
SESSION_PATH="$PROJECT_DIR/$SESSION_ID.jsonl"
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
  rm -f "$SESSION_PATH"
}
trap cleanup EXIT

if [ -z "${PROJECT_DIR:-}" ]; then
  echo "BUG ABSENT: no Claude project directory found under ${HOME:-/home/user}/.claude/projects"
  exit 1
fi

python3 - <<'PY' "$SESSION_PATH" "$SESSION_TITLE" "$SESSION_UUID_PREFIX"
import json
import sys

session_path, session_title, uuid_prefix = sys.argv[1:4]
long_output = ''.join(
    f'output line {i:03d} abcdefghijklmnopqrstuvwxyz\n'
    for i in range(1, 80)
)
rows = [
    {
        'type': 'user',
        'uuid': f'{uuid_prefix}-user',
        'timestamp': '2026-03-25T08:03:59Z',
        'isSidechain': False,
        'isMeta': False,
        'message': {'role': 'user', 'content': session_title},
    },
    {
        'type': 'assistant',
        'uuid': f'{uuid_prefix}-assistant',
        'timestamp': '2026-03-25T08:04:05Z',
        'isSidechain': False,
        'isMeta': False,
        'message': {
            'role': 'assistant',
            'content': [
                {'type': 'text', 'text': 'Synthetic probe for mobile tool output overflow.'},
                {'type': 'tool_result', 'tool_use_id': 'tool-probe', 'content': long_output, 'is_error': False},
            ],
        },
    },
]
with open(session_path, 'w', encoding='utf-8') as fh:
    for row in rows:
        fh.write(json.dumps(row) + '\n')
PY

sleep 1

MESSAGES_JSON="$(curl -fsS "$BASE/api/sessions/$SESSION_ID/messages")"
if ! jq -e --arg title "$SESSION_TITLE" '
  (.messages // []) | length >= 2 and
  .[0].content[0].text == $title and
  .[1].content[1].type == "tool_result" and
  (. [1].content[1].content | contains("output line 079"))
' >/dev/null <<<"$MESSAGES_JSON"; then
  echo "BUG ABSENT: synthetic session did not round-trip through /api/sessions/$SESSION_ID/messages"
  exit 1
fi

SOURCE_MATCHES="$(rg -n -F "'max-height': '120px', overflow: 'auto'" "$APP_TSX" || true)"
if [ -z "$SOURCE_MATCHES" ]; then
  echo "BUG ABSENT: MessageView no longer hard-codes the 120px auto-scrolling tool-result preview"
  exit 1
fi

agent-browser --session-name "$S" set viewport 390 844
agent-browser --session-name "$S" open "$BASE/#$SESSION_ID"
agent-browser --session-name "$S" wait --load networkidle
agent-browser --session-name "$S" wait 2000

RESULT="$(agent-browser --session-name "$S" eval '
(() => {
  const body = [...document.querySelectorAll("div")].find((el) => {
    const style = getComputedStyle(el);
    return el.textContent?.includes("output line 001") &&
      style.overflowY === "auto" &&
      el.scrollHeight > el.clientHeight + 20;
  });
  if (!body) {
    return JSON.stringify({
      found: false,
      url: location.href,
      bodyText: document.body.innerText.slice(0, 300),
    });
  }
  const style = getComputedStyle(body);
  return JSON.stringify({
    found: true,
    url: location.href,
    overflowY: style.overflowY,
    maxHeight: style.maxHeight,
    clientHeight: body.clientHeight,
    scrollHeight: body.scrollHeight,
    textLen: body.textContent.length,
    nestedScroll: body.clientHeight <= 140 && body.scrollHeight > body.clientHeight + 20,
  });
})()
')"

if jq -e 'fromjson | 
  .found == true and
  .overflowY == "auto" and
  .maxHeight == "120px" and
  .clientHeight <= 140 and
  .scrollHeight > (.clientHeight + 20) and
  .nestedScroll == true
' >/dev/null <<<"$RESULT"; then
  echo "BUG PRESENT: mobile tool output renders as an inner 120px auto-scrolling region"
  exit 0
fi

echo "BUG ABSENT: tool output did not render as a nested mobile scroll region"
echo "$RESULT"
exit 1
