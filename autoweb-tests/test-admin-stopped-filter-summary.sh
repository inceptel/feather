#!/bin/bash
# Test that toggleStoppedFilter updates the services-summary to reflect filtered state
FILE=/opt/feather/static/admin/index.html

# Should update summary inside toggleStoppedFilter (not just inside filterServices)
if ! grep -q "stoppedFilterActive" "$FILE"; then
    echo "FAIL: stoppedFilterActive not found in admin page"
    exit 1
fi

# The fix: toggleStoppedFilter should update summary when filter is active
if ! grep -A 50 "function toggleStoppedFilter" "$FILE" | grep -q "summary.*textContent.*running.*filtered"; then
    echo "FAIL: toggleStoppedFilter should update summary with '(filtered)' label when stopped filter active"
    exit 1
fi

# Should also reset summary when filter is deactivated
if ! grep -A 60 "function toggleStoppedFilter" "$FILE" | grep -q "running === total.*text-apple-9\|text-apple-9.*running === total"; then
    echo "FAIL: toggleStoppedFilter should reset summary to full count on deactivation"
    exit 1
fi

echo "PASS: toggleStoppedFilter updates services-summary for filtered state"
