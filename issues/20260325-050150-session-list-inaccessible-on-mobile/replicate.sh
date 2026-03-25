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
agent-browser --session-name "$S" open "http://127.0.0.1:$PORT/" >/dev/null
agent-browser --session-name "$S" wait --load networkidle >/dev/null
agent-browser --session-name "$S" wait 2000 >/dev/null

# Open the mobile drawer via the visible hamburger button.
agent-browser --session-name "$S" eval 'document.querySelector("button")?.click(), "opened"' >/dev/null
agent-browser --session-name "$S" wait 1000 >/dev/null

RESULT="$(
  agent-browser --session-name "$S" eval '(() => {
    const pointerRows = [...document.querySelectorAll("div")].filter((el) => {
      const text = (el.textContent || "").trim();
      if (!text || el.querySelector("button")) return false;
      return getComputedStyle(el).cursor === "pointer";
    });
    const badRows = pointerRows.filter((el) => !el.getAttribute("role") && el.getAttribute("tabindex") == null);
    const buttonCount = document.querySelectorAll("button").length;
    return badRows.length > 0 && buttonCount <= 2;
  })()'
)"

if [ "$RESULT" = "true" ]; then
  echo "BUG PRESENT"
  exit 0
else
  echo "BUG ABSENT"
  exit 1
fi
