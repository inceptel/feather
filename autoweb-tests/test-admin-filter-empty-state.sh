#!/bin/bash
# Test: admin service filter shows empty state when no services match
set -e
FILE=/opt/feather/static/admin/index.html

# Should create an empty state element when no services match
grep -q 'services-filter-empty' "$FILE" || { echo "FAIL: missing services-filter-empty element id"; exit 1; }

# Should show the query in the empty state message
grep -q 'No services matching' "$FILE" || { echo "FAIL: missing 'No services matching' text"; exit 1; }

echo "PASS: admin filter empty state present"
