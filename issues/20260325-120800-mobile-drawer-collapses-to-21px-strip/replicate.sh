#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
set -euo pipefail

PORT="${PORT:-3301}"
S=""

cleanup() {
  if [[ -n "$S" ]]; then
    agent-browser --session-name "$S" close >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

RESULT=""
for attempt in 1 2 3; do
  S="replicate-drawer-width-$$-$attempt"
  if agent-browser --session-name "$S" set viewport 390 844 >/dev/null 2>&1 &&
     agent-browser --session-name "$S" open "http://localhost:$PORT/" >/dev/null 2>&1 &&
     agent-browser --session-name "$S" wait --load networkidle >/dev/null 2>&1 &&
     agent-browser --session-name "$S" wait 2000 >/dev/null 2>&1 &&
     agent-browser --session-name "$S" find role button click --name "☰" >/dev/null 2>&1 &&
     agent-browser --session-name "$S" wait 500 >/dev/null 2>&1; then
    RESULT="$(agent-browser --session-name "$S" eval '(() => {
      const root = document.querySelector("#root > div");
      const close = document.querySelector("button[aria-label=\"Close session drawer\"]");
      if (!root || !close) return JSON.stringify({ error: "drawer did not open" });
      const children = [...root.children];
      const drawer = children.find((el) => el.contains(close));
      if (!drawer) return JSON.stringify({ error: "drawer container not found" });
      const rect = drawer.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      return JSON.stringify({
        viewportWidth,
        drawerWidth: rect.width,
        widthRatio: viewportWidth ? rect.width / viewportWidth : null,
        bugPresent: rect.width < 44,
        buttonVisible: !![...drawer.querySelectorAll("button")].find((el) => (el.textContent || "").includes("+ New Claude"))
      });
    })()')"
    break
  fi
  cleanup
  S=""
  sleep 2
done

if [[ -z "$RESULT" ]]; then
  echo "BUG ABSENT: failed to inspect drawer geometry after 3 attempts"
  exit 1
fi

NORMALIZED_RESULT="$(printf '%s' "$RESULT" | tr -d '\\')"

if [[ "$NORMALIZED_RESULT" == *'"bugPresent":true'* ]]; then
  echo "BUG PRESENT: $NORMALIZED_RESULT"
  exit 0
fi

echo "BUG ABSENT: $NORMALIZED_RESULT"
exit 1
