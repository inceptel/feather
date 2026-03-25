#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
S="replicate-$$"

cleanup() {
  agent-browser --session-name "$S" close >/dev/null 2>&1 || true
}
trap cleanup EXIT

agent-browser --session-name "$S" set viewport 390 844
agent-browser --session-name "$S" open "http://localhost:$PORT/"
agent-browser --session-name "$S" wait --load networkidle
agent-browser --session-name "$S" wait 2000
agent-browser --session-name "$S" find role button click --name "☰"
agent-browser --session-name "$S" wait 1000

SIZE_RAW="$(agent-browser --session-name "$S" eval '(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((el) => (el.textContent || "").trim() === "\u00d7");
  if (!btn) return "MISSING";
  const r = btn.getBoundingClientRect();
  return `${r.width} ${r.height}`;
})()' | tail -n 1)"
SIZE="$(printf '%s' "$SIZE_RAW" | tr -d '"')"

if [ "$SIZE" = "MISSING" ]; then
  echo "BUG ABSENT: close button not found"
  exit 1
fi

WIDTH="$(printf '%s' "$SIZE" | awk '{print $1}')"
HEIGHT="$(printf '%s' "$SIZE" | awk '{print $2}')"

if awk "BEGIN { exit !($WIDTH < 44 || $HEIGHT < 44) }"; then
  echo "BUG PRESENT: ${WIDTH}x${HEIGHT}"
  exit 0
fi

echo "BUG ABSENT: ${WIDTH}x${HEIGHT}"
exit 1
