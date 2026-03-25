#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
ROOT="/home/user/feather-dev/w5"
TERMINAL_COMPONENT="$ROOT/frontend/src/components/Terminal.tsx"
APP_COMPONENT="$ROOT/frontend/src/App.tsx"
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

browser() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if agent-browser --session-name "$S" "$@"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Source-backed guard: the disconnected terminal path only writes a marker
# and the app has no dedicated terminal recovery affordance.
grep -Fq "ws.onclose = () => term?.write('\\r\\n\\x1b[90m[disconnected]\\x1b[0m\\r\\n')" "$TERMINAL_COMPONENT"
if rg -n "Retry|retry|Reconnect|reconnect|Return to chat|Back to chat" "$APP_COMPONENT" "$TERMINAL_COMPONENT" >/dev/null 2>&1; then
  echo "BUG ABSENT: recovery affordance exists in source"
  exit 1
fi

browser set viewport 390 844 >/dev/null
browser open "http://localhost:$PORT/" >/dev/null
browser wait --load networkidle >/dev/null
browser wait 2000 >/dev/null

browser eval 'document.querySelector("button")?.click(); "opened-menu"' >/dev/null
browser wait 1000 >/dev/null
browser eval 'const buttons=[...document.querySelectorAll("button")]; const session=buttons.find(b=>b.textContent?.includes("WORKER_NUM=")); if(!session) throw new Error("no visible session"); session.click(); "selected-session"' >/dev/null
browser wait --load networkidle >/dev/null
browser wait 1500 >/dev/null
browser eval 'const termTab=[...document.querySelectorAll("button")].find(b=>b.textContent?.trim()==="Terminal"); if(!termTab) throw new Error("no terminal tab"); termTab.click(); "opened-terminal"' >/dev/null
browser wait 2000 >/dev/null

RESULT="$(browser eval '(() => {
  const xtermText = [...document.querySelectorAll(".xterm-rows, .xterm-accessibility-tree")]
    .map((n) => n.textContent || "")
    .join(" ");
  const buttonLabels = [...document.querySelectorAll("button")]
    .map((b) => (b.textContent || "").trim())
    .filter(Boolean);
  const hasDisconnected = xtermText.includes("[disconnected]");
  const hasRecoveryAction = buttonLabels.some((label) => /retry|reconnect|return to chat|back to chat/i.test(label));
  return hasDisconnected && !hasRecoveryAction;
})()')"

if [ "$RESULT" = "true" ]; then
  echo "BUG PRESENT"
  exit 0
fi

echo "BUG ABSENT"
browser eval '(() => {
  const xtermText = [...document.querySelectorAll(".xterm-rows, .xterm-accessibility-tree")]
    .map((n) => n.textContent || "")
    .join(" ");
  const buttonLabels = [...document.querySelectorAll("button")]
    .map((b) => (b.textContent || "").trim())
    .filter(Boolean);
  const hasDisconnected = xtermText.includes("[disconnected]");
  const hasRecoveryAction = buttonLabels.some((label) => /retry|reconnect|return to chat|back to chat/i.test(label));
  return JSON.stringify({ hasDisconnected, hasRecoveryAction, buttonLabels, xtermText });
})()'
exit 1
