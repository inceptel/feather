#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3305}"
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 1500 >/dev/null
agent-browser --session-name "$S" eval '
  const buttons = Array.from(document.querySelectorAll("button"));
  const menu = buttons.find((button) => {
    const rect = button.getBoundingClientRect();
    const label = (button.getAttribute("aria-label") || "").toLowerCase();
    const text = (button.textContent || "").trim();
    return label.includes("session drawer") ||
      text.includes("\u2630") ||
      (rect.top <= 80 && rect.left <= 80 && rect.width >= 40 && rect.height >= 40);
  });
  if (!menu) throw new Error("Could not find hamburger button");
  menu.click();
  true;
' >/dev/null
agent-browser --session-name "$S" wait 1000 >/dev/null

RESULT="$(agent-browser --session-name "$S" eval '
  JSON.stringify({
    navCount: document.querySelectorAll("nav,[role=\"navigation\"]").length,
    hasNewClaude: Array.from(document.querySelectorAll("button")).some((button) =>
      /new claude/i.test(button.textContent || "")
    ),
    drawerVisible: !!Array.from(document.querySelectorAll("button")).find((button) =>
      /close session drawer/i.test(button.getAttribute("aria-label") || "")
    )
  })
')"

NORMALIZED_RESULT="$(printf '%s' "$RESULT" | sed 's/^"//; s/"$//; s/\\"/"/g')"

if printf '%s' "$NORMALIZED_RESULT" | grep -Fq '"drawerVisible":true' &&
   printf '%s' "$NORMALIZED_RESULT" | grep -Fq '"hasNewClaude":true' &&
   printf '%s' "$NORMALIZED_RESULT" | grep -Fq '"navCount":0'; then
  echo "BUG PRESENT: open session drawer exposes no nav landmark ($NORMALIZED_RESULT)"
  exit 0
fi

echo "BUG ABSENT: session drawer exposes navigation semantics ($NORMALIZED_RESULT)"
exit 1
