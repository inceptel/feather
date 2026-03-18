#!/bin/bash
# Test: admin services section has a "N stopped" quick-filter button
FILE="/opt/feather/static/admin/index.html"

# stopped-filter-btn element must exist
grep -q 'id="stopped-filter-btn"' "$FILE" || { echo "FAIL: stopped-filter-btn element missing"; exit 1; }

# toggleStoppedFilter function must exist
grep -q "function toggleStoppedFilter" "$FILE" || { echo "FAIL: toggleStoppedFilter function missing"; exit 1; }

# stoppedFilterActive state variable must exist
grep -q "stoppedFilterActive" "$FILE" || { echo "FAIL: stoppedFilterActive state missing"; exit 1; }

# Button must be hidden by default (only shows when there are stopped services)
grep -q 'stopped-filter-btn.*class="hidden' "$FILE" || grep -q "class=\"hidden.*stopped-filter-btn" "$FILE" || \
  grep -A2 'id="stopped-filter-btn"' "$FILE" | grep -q "hidden" || { echo "FAIL: stopped-filter-btn not hidden by default"; exit 1; }

# Must show ember color (red-ish) for stopped services
grep -q 'ember-9' "$FILE" || { echo "FAIL: ember color not used for stopped button"; exit 1; }

echo "PASS: admin stopped-filter-btn present"
exit 0
