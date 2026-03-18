#!/bin/bash
# test-admin-filter-counts-flapping.sh
# Tests: filterServices counts flapping (amber-9) services as running in the filtered summary
# Bug fix: was only checking bg-apple-9, missing bg-amber-9 flapping services

FILE="/opt/feather/static/admin/index.html"

# Must count amber-9 dots as running (flapping services are still running)
grep -q 'bg-amber-9' "$FILE" || { echo "FAIL: bg-amber-9 not referenced in filterServices"; exit 1; }

# The filterServices function must check both apple-9 and amber-9
grep -A2 'visibleRunning++' "$FILE" | grep -q 'amber-9' || { echo "FAIL: filterServices does not count amber-9 as running"; exit 1; }

echo "PASS: filterServices counts flapping (amber-9) services as running"
exit 0
