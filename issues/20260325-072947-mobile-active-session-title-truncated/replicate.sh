#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844 >/dev/null
agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 2000 >/dev/null

# Open the mobile drawer.
DRAWER_RESULT="$(agent-browser --session-name "$S" eval '
(() => {
  const toggle = [...document.querySelectorAll("button")].find((button) => button.innerText.trim() === "☰");
  if (!toggle) return "missing-drawer-toggle";
  toggle.click();
  return "opened";
})()
')"

if [ "$DRAWER_RESULT" != '"opened"' ]; then
  echo "BUG ABSENT: mobile drawer toggle was not available"
  exit 1
fi

agent-browser --session-name "$S" wait 700 >/dev/null

# Select any long-titled worker session from the drawer.
CLICK_RESULT="$(agent-browser --session-name "$S" eval '
(() => {
  const target = [...document.querySelectorAll("button")].find((button) => {
    const title = button.innerText.split("\n")[0]?.trim() || "";
    return title.startsWith("WORKER_NUM=") && title.includes("WORKTREE=") && title.length > 60;
  });
  if (!target) return "missing-target-session";
  window.__reproTitle = target.innerText.split("\n")[0].trim();
  target.click();
  return "clicked";
})()
')"

if [ "$CLICK_RESULT" != '"clicked"' ]; then
  echo "BUG ABSENT: expected long-titled target session was not available"
  exit 1
fi

agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 1500 >/dev/null

MEASURED="$(agent-browser --session-name "$S" eval '
(() => {
  const targetTitle = window.__reproTitle;
  if (!targetTitle) return "found=false";
  const title = [...document.querySelectorAll("span")].find((span) =>
    span.textContent?.trim() === targetTitle
    && span.getBoundingClientRect().width > 0
  );
  if (!title) return "found=false";

  return `found=true;clientWidth=${title.clientWidth};scrollWidth=${title.scrollWidth};text=${targetTitle}`;
})()
')"

if echo "$MEASURED" | grep -q 'found=true' && \
   [ "$(echo "$MEASURED" | grep -o 'scrollWidth=[0-9]*' | cut -d= -f2)" -gt "$(echo "$MEASURED" | grep -o 'clientWidth=[0-9]*' | cut -d= -f2)" ]; then
  echo "BUG PRESENT: $MEASURED"
  exit 0
fi

echo "BUG ABSENT: $MEASURED"
exit 1
