#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
S="replicate-nav-labels-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844
agent-browser --session-name "$S" open "http://localhost:$PORT/"
agent-browser --session-name "$S" wait 3000

RESULT="$(agent-browser --session-name "$S" eval '(() => {
  const buttons = [...document.querySelectorAll("button")].filter((button) => {
    const rect = button.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })

  const glyphOnlyButton = buttons.find((button) => {
    const text = (button.textContent || "").trim()
    const ariaLabel = (button.getAttribute("aria-label") || "").trim()
    const title = (button.getAttribute("title") || "").trim()
    return text === "☰" && ariaLabel === "" && title === ""
  })

  return glyphOnlyButton ? "true" : "false"
})()')"

RESULT="${RESULT//\"/}"
RESULT="$(printf '%s' "$RESULT" | tr -d '[:space:]')"

if [ "$RESULT" = "true" ]; then
  echo "BUG PRESENT: mobile navigation button is exposed only as the glyph ☰"
  exit 0
fi

echo "BUG ABSENT: mobile navigation button has a descriptive accessible name"
exit 1
