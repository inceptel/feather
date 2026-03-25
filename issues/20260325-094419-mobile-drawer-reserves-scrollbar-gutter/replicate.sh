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

agent-browser --session-name "$S" eval '(() => {
  const trigger = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "☰")
  if (!trigger) return false
  trigger.click()
  return true
})()' >/dev/null

agent-browser --session-name "$S" wait 1000 >/dev/null

RESULT=$(agent-browser --session-name "$S" eval '(() => {
  const candidates = [...document.querySelectorAll("div")]
    .map((element) => {
      const style = getComputedStyle(element)
      return {
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
        offsetWidth: element.offsetWidth,
        overflowY: style.overflowY,
        scrollHeight: element.scrollHeight,
        text: (element.textContent || "").trim().slice(0, 120),
      }
    })
    .filter((entry) =>
      entry.overflowY === "auto" &&
      entry.scrollHeight > entry.clientHeight &&
      entry.offsetWidth >= 295 &&
      entry.clientWidth > 0
    )
    .sort((a, b) => (b.offsetWidth - b.clientWidth) - (a.offsetWidth - a.clientWidth))

  const drawer = candidates[0]
  if (!drawer) {
    return "STATUS:ABSENT found=false"
  }

  const gutter = drawer.offsetWidth - drawer.clientWidth
  return [
    gutter >= 12 ? "STATUS:PRESENT" : "STATUS:ABSENT",
    `found=true`,
    `gutter=${gutter}`,
    `clientWidth=${drawer.clientWidth}`,
    `offsetWidth=${drawer.offsetWidth}`,
    `overflowY=${drawer.overflowY}`,
    `scrollHeight=${drawer.scrollHeight}`,
    `clientHeight=${drawer.clientHeight}`,
    `text=${drawer.text}`,
  ].join(" ")
})()')

echo "$RESULT"

if printf '%s' "$RESULT" | grep -q 'STATUS:PRESENT'; then
  echo "BUG PRESENT"
  exit 0
fi

echo "BUG ABSENT"
exit 1
