#!/bin/bash
# Test: Admin services show amber dot + sse-live animation for recently-restarted (flapping) services
FILE="/opt/feather/static/admin/index.html"
PASS=0; FAIL=0

check() {
    local desc="$1"; local result="$2"
    if [ "$result" -ge "1" ] 2>/dev/null; then echo "PASS: $desc"; ((PASS++)); else echo "FAIL: $desc"; ((FAIL++)); fi
}

# uptimeSeconds helper function defined
check "uptimeSeconds function defined" $(grep -c 'function uptimeSeconds' "$FILE")

# flapping detection logic
check "flapping detection: < 60s uptime" $(grep -c 'uptimeSecs < 60' "$FILE")

# amber dot for flapping
check "amber dot for flapping service" $(grep -c "flapping ? 'bg-amber-9'" "$FILE")

# sse-live pulse on flapping dot
check "sse-live class on flapping dot" $(grep -c "flapping ? ' sse-live'" "$FILE")

# service name truncates long names
check "service name has truncate class" $(grep -c 'font-medium text-sm truncate' "$FILE")

# tooltip on service card
check "service card has title tooltip" $(grep -c 'titleAttr' "$FILE")

echo "---"
echo "$PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
