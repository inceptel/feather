#!/bin/bash
# Test: stopped filter uses bg-ember-9 to identify stopped services, not absence of bg-apple-9
# (flapping services are bg-amber-9 and are RUNNING — must not appear in stopped filter)
FILE="/opt/feather/static/admin/index.html"
PASS=0; FAIL=0

check() {
    local desc="$1"; local result="$2"
    if [ "$result" -ge "1" ] 2>/dev/null; then echo "PASS: $desc"; ((PASS++)); else echo "FAIL: $desc"; ((FAIL++)); fi
}

# toggleStoppedFilter must use bg-ember-9 to identify stopped services
check "stopped filter uses bg-ember-9 to detect stopped services" \
    $(grep -A10 'function toggleStoppedFilter' "$FILE" | grep -c 'bg-ember-9')

# toggleStoppedFilter must NOT use 'bg-apple-9' check to determine running state
# (that approach incorrectly treats flapping/amber services as stopped)
result=$(grep -A10 'function toggleStoppedFilter' "$FILE" | grep -c 'bg-apple-9')
if [ "$result" -eq "0" ]; then
    echo "PASS: stopped filter does not use bg-apple-9 (flapping-safe)"
    ((PASS++))
else
    echo "FAIL: stopped filter still uses bg-apple-9 (will incorrectly hide flapping services)"
    ((FAIL++))
fi

echo "---"
echo "$PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
