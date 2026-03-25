#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
TITLE='WORKER_NUM=2 WORKTREE=/home/user/feather-dev/w2 PORT=3302 WORKER_DIR=/home/user/'
COMMAND_SNIPPET='printf "%s\tskip\tNo new issues to replicate'
OUTPUT_SNIPPET='/home/user/feather-aw/w2/breadcrumbs.md'

SESSIONS_JSON="$(curl -fsS "http://localhost:${PORT}/api/sessions")"
MATCHING_SESSION_IDS="$(
  printf '%s' "$SESSIONS_JSON" \
    | jq -r --arg title "$TITLE" '.sessions[]? | select(.title == $title) | .id'
)"

if [ -z "$MATCHING_SESSION_IDS" ]; then
  echo "BUG ABSENT: target worker-2 session title not found on port ${PORT}"
  exit 1
fi

SESSION_ID=""
while IFS= read -r candidate_id; do
  [ -n "$candidate_id" ] || continue
  MESSAGES_JSON="$(curl -fsS "http://localhost:${PORT}/api/sessions/${candidate_id}/messages")"
  TRANSCRIPT_TEXT="$(
    printf '%s' "$MESSAGES_JSON" \
      | jq -r '.messages[] | .content[]? | if .type == "tool_use" and .name == "Bash" then .input.command elif .type == "tool_result" then (if (.content | type) == "string" then .content else ([.content[]?.text] | join("")) end) else empty end'
  )"
  if printf '%s\n' "$TRANSCRIPT_TEXT" | rg -Fq "$COMMAND_SNIPPET" && printf '%s\n' "$TRANSCRIPT_TEXT" | rg -Fq "$OUTPUT_SNIPPET"; then
    SESSION_ID="$candidate_id"
    break
  fi
done <<< "$MATCHING_SESSION_IDS"

if [ -z "$SESSION_ID" ]; then
  echo "BUG ABSENT: no worker-2 session currently contains both the long command and output path snippets"
  exit 1
fi

S="replicate-tool-wrap-$$"
cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://localhost:${PORT}/#${SESSION_ID}" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 2000 >/dev/null

RESULT="$(
  agent-browser --session-name "$S" eval '(() => {
    const commandSnippet = "No new issues to replicate";
    const outputSnippet = "/home/user/feather-aw/w2/breadcrumbs.md";
    const commandPre = [...document.querySelectorAll("details pre")].find((pre) =>
      (pre.textContent || "").includes(commandSnippet)
    );
    const outputNode = [...document.querySelectorAll("div")].find((div) =>
      (div.textContent || "").includes(outputSnippet) &&
      getComputedStyle(div).whiteSpace === "pre-wrap"
    );
    if (!commandPre || !outputNode) {
      return JSON.stringify({
        bugPresent: false,
        reason: "target tool nodes not found",
        commandFound: Boolean(commandPre),
        outputFound: Boolean(outputNode),
      });
    }
    const commandStyle = getComputedStyle(commandPre);
    const outputStyle = getComputedStyle(outputNode);
    const commandBreaksAnywhere = commandStyle.whiteSpace === "pre-wrap" && commandStyle.wordBreak === "break-all";
    const outputBreaksAnywhere = outputStyle.whiteSpace === "pre-wrap" && outputStyle.wordBreak === "break-all";
    return JSON.stringify({
      bugPresent: commandBreaksAnywhere && outputBreaksAnywhere,
      commandWhiteSpace: commandStyle.whiteSpace,
      commandWordBreak: commandStyle.wordBreak,
      commandOverflowX: commandStyle.overflowX,
      outputWhiteSpace: outputStyle.whiteSpace,
      outputWordBreak: outputStyle.wordBreak,
      outputOverflowX: outputStyle.overflowX,
    });
  })()'
)"

NORMALIZED_RESULT="$(printf '%s' "$RESULT" | jq -c 'if type == "string" then fromjson else . end')"
BUG_PRESENT="$(printf '%s' "$NORMALIZED_RESULT" | jq -r '.bugPresent')"
if [ "$BUG_PRESENT" = "true" ]; then
  echo "BUG PRESENT: $NORMALIZED_RESULT"
  exit 0
fi

echo "BUG ABSENT: $NORMALIZED_RESULT"
exit 1
