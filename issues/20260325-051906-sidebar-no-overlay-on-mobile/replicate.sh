#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
# Bug: Sidebar uses static positioning in flex layout instead of overlay on mobile
set -e
PORT="${PORT:-3302}"
S="replicate-sidebar-$$"

# Setup mobile viewport
agent-browser --session-name $S set viewport 390 844
agent-browser --session-name $S open "http://localhost:$PORT/"
agent-browser --session-name $S wait --load networkidle
agent-browser --session-name $S wait 2000

# Click hamburger to open sidebar via JS, then wait for it to render
agent-browser --session-name $S eval 'document.querySelector("button")?.click(); "ok"'
agent-browser --session-name $S wait 2000

# Check if sidebar is static-positioned (pushing content) vs overlay (fixed/absolute)
# Retry up to 3 times with short waits in case animation is slow
RESULT="no-sidebar"
for attempt in 1 2 3; do
    RESULT=$(agent-browser --session-name $S eval '
    (() => {
      const flex = document.getElementById("root")?.children[0];
      if (!flex || flex.children.length < 2) return "no-sidebar";
      const sidebarEl = flex.children[0];
      const rect = sidebarEl.getBoundingClientRect();
      const cs = window.getComputedStyle(sidebarEl);
      const pos = cs.position;
      const w = rect.width;
      // Bug: sidebar is position:static with width >= 250px in a flex row
      // Fix would be: position:fixed or position:absolute (overlay), or full-width
      if (w >= 250 && (pos === "static" || pos === "relative")) {
        return "bug-present";
      }
      if (w < 10) {
        return "sidebar-closed";
      }
      return "bug-absent";
    })()
    ')
    if [ "$RESULT" = '"bug-present"' ] || [ "$RESULT" = 'bug-present' ]; then
        break
    fi
    # Sidebar may not have opened yet, try clicking again and wait
    agent-browser --session-name $S eval 'document.querySelector("button")?.click(); "ok"' >/dev/null 2>&1 || true
    agent-browser --session-name $S wait 1500
done

agent-browser --session-name $S close 2>/dev/null || true

if [ "$RESULT" = '"bug-present"' ] || [ "$RESULT" = 'bug-present' ]; then
    echo "BUG PRESENT: Sidebar is static-positioned at 300px, pushing content instead of overlaying"
    exit 0
else
    echo "BUG ABSENT: Sidebar uses overlay positioning (result: $RESULT)"
    exit 1
fi
