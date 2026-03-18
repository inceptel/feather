#!/bin/bash
# Test: SSE indicator gets sse-live pulse class on connect, removed on disconnect
FILE="/opt/feather/static/admin/index.html"
PASS=0; FAIL=0

check() {
    local desc="$1"; local result="$2"
    if [ "$result" -ge "1" ] 2>/dev/null; then echo "PASS: $desc"; ((PASS++)); else echo "FAIL: $desc"; ((FAIL++)); fi
}

# ssePulse keyframe defined
check "ssePulse keyframe defined" $(grep -c 'ssePulse' "$FILE")

# sse-live class defined with animation
check "sse-live class has animation" $(grep -c '\.sse-live' "$FILE")

# onopen adds sse-live class
check "onopen adds sse-live" $(grep -c "classList.add.*sse-live" "$FILE")

# onerror removes sse-live class
check "onerror removes sse-live" $(grep -c "classList.remove.*sse-live" "$FILE")

echo "---"
echo "$PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
