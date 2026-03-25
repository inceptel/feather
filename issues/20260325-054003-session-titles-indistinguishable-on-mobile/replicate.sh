#!/bin/bash
# Exit 0 = bug present (FAIL), Exit 1 = bug absent (PASS)
# Bug: Session titles are indistinguishable on mobile — most start with "WORKER_NUM="
PORT="${PORT:-3302}"
S="replicate-$$"

cleanup() {
    agent-browser --session-name $S close 2>/dev/null || true
}
trap cleanup EXIT

# Open page and set mobile viewport
agent-browser --session-name $S open "http://localhost:$PORT/" || { echo "Failed to open"; exit 1; }
agent-browser --session-name $S set viewport 390 844
agent-browser --session-name $S wait --load networkidle
agent-browser --session-name $S wait 3000

# Wait for hamburger button to appear, then click it
CLICKED="false"
for attempt in 1 2 3 4 5 6 7 8; do
    FOUND=$(agent-browser --session-name $S eval '
    (() => {
      const btns = document.querySelectorAll("button");
      for (const b of btns) {
        if (b.textContent.trim() === "☰") { b.click(); return "clicked"; }
      }
      return "not_found";
    })()
    ' 2>/dev/null || echo '"not_found"')
    if echo "$FOUND" | grep -q "clicked"; then
        CLICKED="true"
        break
    fi
    agent-browser --session-name $S wait 1000
done

if [ "$CLICKED" = "false" ]; then
    echo "Failed to find hamburger button after 8 attempts"
    exit 1
fi

agent-browser --session-name $S wait 1000

# Wait for session list to populate
for attempt in 1 2 3 4 5 6 7 8; do
    COUNT=$(agent-browser --session-name $S eval 'document.querySelectorAll("div[style*=cursor]").length' 2>/dev/null || echo "0")
    COUNT_CLEAN=$(echo "$COUNT" | tr -d '"')
    if [ "$COUNT_CLEAN" -ge 5 ] 2>/dev/null; then
        break
    fi
    agent-browser --session-name $S wait 1500
done

# Count session titles: how many start with "WORKER_NUM=" vs total
RESULT=$(agent-browser --session-name $S eval '
(() => {
  const divs = document.querySelectorAll("div[style*=cursor]");
  let total = 0;
  let workerNum = 0;
  for (const d of divs) {
    const text = d.textContent.trim();
    total++;
    if (text.startsWith("WORKER_NUM=")) workerNum++;
  }
  return total + ":" + workerNum;
})()
' 2>/dev/null || echo '"0:0"')

echo "Result: $RESULT"

# Parse total:workerNum
CLEAN=$(echo "$RESULT" | tr -d '"')
TOTAL=$(echo "$CLEAN" | cut -d: -f1)
WORKER=$(echo "$CLEAN" | cut -d: -f2)

echo "Total sessions: $TOTAL, Starting with WORKER_NUM=: $WORKER"

# Need at least 5 sessions, and >80% must start with WORKER_NUM=
if [ "$TOTAL" -ge 5 ] 2>/dev/null && [ "$WORKER" -ge 5 ] 2>/dev/null; then
    PCT=$((WORKER * 100 / TOTAL))
    if [ "$PCT" -gt 80 ]; then
        echo "BUG PRESENT: $WORKER/$TOTAL (${PCT}%) session titles start with WORKER_NUM="
        exit 0
    fi
fi

echo "BUG ABSENT"
exit 1
