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

BUG_PRESENT="$(agent-browser --session-name "$S" eval '
(() => {
  const bodyText = document.body.innerText || "";
  const buttons = [...document.querySelectorAll("button")].filter((button) => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden";
  });
  const hasPrompt = bodyText.includes("Open a session or create a new one");
  const onlyHamburger =
    buttons.length === 1 &&
    (buttons[0].innerText || "").trim() === "☰" &&
    !buttons[0].getAttribute("aria-label");

  return hasPrompt && onlyHamburger;
})()
')"

if [ "$BUG_PRESENT" = "true" ]; then
  echo "BUG PRESENT"
  exit 0
fi

echo "BUG ABSENT"
exit 1
