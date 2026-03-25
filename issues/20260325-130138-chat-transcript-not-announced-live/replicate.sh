#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
BASE="http://localhost:$PORT"
CLAUDE_PROJECTS="${HOME:-/home/user}/.claude/projects"
S="replicate-$$"
SESSION_ID="w5-live-region-probe-$$"
SESSION_TITLE="Live region probe title $$"
ASSISTANT_TEXT="Assistant reply two for live region probe $$."

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
  if [ -n "${SESSION_FILE:-}" ]; then
    rm -f "$SESSION_FILE"
  fi
}
trap cleanup EXIT

PROJECT_DIR="$(find "$CLAUDE_PROJECTS" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "$PROJECT_DIR" ]; then
  echo "BUG ABSENT: no project directory exists under $CLAUDE_PROJECTS"
  exit 1
fi

SESSION_FILE="$PROJECT_DIR/$SESSION_ID.jsonl"
cat >"$SESSION_FILE" <<EOF
{"type":"user","uuid":"u1","timestamp":"2026-03-25T14:35:00Z","isSidechain":false,"isMeta":false,"message":{"role":"user","content":"$SESSION_TITLE"}}
{"type":"assistant","uuid":"a1","timestamp":"2026-03-25T14:35:05Z","isSidechain":false,"isMeta":false,"message":{"role":"assistant","content":[{"type":"text","text":"Assistant reply one for live region probe $$."}]}}
{"type":"assistant","uuid":"a2","timestamp":"2026-03-25T14:35:10Z","isSidechain":false,"isMeta":false,"message":{"role":"assistant","content":[{"type":"text","text":"$ASSISTANT_TEXT"}]}}
EOF

VISIBLE="false"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  VISIBLE="$(
    curl -fsS "$BASE/api/sessions?limit=50" |
      jq -r --arg id "$SESSION_ID" --arg title "$SESSION_TITLE" '
        first((.sessions // [])[] | select(.id == $id and .title == $title) | "true") // "false"
      '
  )"
  [ "$VISIBLE" = "true" ] && break
  sleep 0.5
done

if [ "$VISIBLE" != "true" ]; then
  echo "BUG ABSENT: synthetic session $SESSION_ID did not appear in /api/sessions"
  exit 1
fi

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "$BASE/#$SESSION_ID" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 2000 >/dev/null

MEASURED_RAW="$(
  agent-browser --session-name "$S" eval "$(cat <<EOF
(function () {
  const assistantText = ${ASSISTANT_TEXT@Q};
  const titleText = ${SESSION_TITLE@Q};
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = null;
  while (walker.nextNode()) {
    if ((walker.currentNode.nodeValue || '').includes(assistantText)) {
      node = walker.currentNode;
      break;
    }
  }
  let el = node ? node.parentElement : null;
  let container = null;
  while (el) {
    const cs = getComputedStyle(el);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.tagName === 'DIV') {
      container = el;
      break;
    }
    el = el.parentElement;
  }
  return JSON.stringify({
    bodyHasTitle: document.body.innerText.includes(titleText),
    foundText: !!node,
    containerFound: !!container,
    role: container ? container.getAttribute('role') : null,
    ariaLive: container ? container.getAttribute('aria-live') : null,
    ariaLabel: container ? container.getAttribute('aria-label') : null,
    clientHeight: container ? container.clientHeight : null,
    scrollHeight: container ? container.scrollHeight : null
  });
})()
EOF
)"
)"

MEASURED="$(
  printf '%s\n' "$MEASURED_RAW" | jq -c 'fromjson'
)"

BUG_PRESENT="$(
  printf '%s\n' "$MEASURED" |
    jq -r '
      (.bodyHasTitle == true) and
      (.foundText == true) and
      (.containerFound == true) and
      (.role == null) and
      (.ariaLive == null) and
      (.ariaLabel == null)
    '
)"

if [ "$BUG_PRESENT" = "true" ]; then
  echo "BUG PRESENT: transcript container renders session content but has no role, aria-live, or aria-label: $MEASURED"
  exit 0
fi

echo "BUG ABSENT: transcript container semantics no longer match the reported bug: $MEASURED"
exit 1
