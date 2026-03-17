#!/bin/bash
# Test: admin timeAgo shows weeks (Xw ago) and months (Xmo ago) for old builds
FILE="/opt/feather/static/admin/index.html"

# Check that weeks are handled (7 * 86400)
grep -q '7 \* 86400' "$FILE" || { echo "FAIL: weeks threshold (7 * 86400) missing in timeAgo"; exit 1; }

# Check that 'w ago' suffix is present
grep -q "'w ago'" "$FILE" || { echo "FAIL: 'w ago' suffix missing in timeAgo"; exit 1; }

# Check that months are handled (30 * 86400)
grep -q '30 \* 86400' "$FILE" || { echo "FAIL: months threshold (30 * 86400) missing in timeAgo"; exit 1; }

# Check that 'mo ago' suffix is present
grep -q "'mo ago'" "$FILE" || { echo "FAIL: 'mo ago' suffix missing in timeAgo"; exit 1; }

echo "PASS: admin timeAgo shows weeks and months for older builds"
exit 0
