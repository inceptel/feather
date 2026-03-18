#!/bin/bash
# Test: when text filter is typed, stopped filter active state is visually reset
FILE="/opt/feather/static/admin/index.html"

# filterServices must handle stoppedFilterActive reset when q is truthy
grep -A10 "function filterServices" "$FILE" | grep -q "stoppedFilterActive = false" || \
  { echo "FAIL: filterServices does not reset stoppedFilterActive on text query"; exit 1; }

# The reset block must also remove ring-1 and ring-ember-9 from the stopped button
grep -A15 "function filterServices" "$FILE" | grep -q "ring-1" || \
  { echo "FAIL: filterServices does not remove ring-1 from stopped-filter-btn on text filter"; exit 1; }

grep -A15 "function filterServices" "$FILE" | grep -q "ring-ember-9" || \
  { echo "FAIL: filterServices does not remove ring-ember-9 from stopped-filter-btn on text filter"; exit 1; }

echo "PASS: admin stopped filter visual state resets when text filter is typed"
exit 0
