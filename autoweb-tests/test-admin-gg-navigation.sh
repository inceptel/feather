#!/bin/bash
# Test: g/G keyboard shortcuts jump to first/last service card in admin
set -e
FILE=/opt/feather/static/admin/index.html

# navigateServicesTo function exists
grep -q "navigateServicesTo" "$FILE" || { echo "FAIL: navigateServicesTo function not found"; exit 1; }

# g key calls navigateServicesTo(0)
grep -q "navigateServicesTo(0)" "$FILE" || { echo "FAIL: g key -> navigateServicesTo(0) not found"; exit 1; }

# G key calls navigateServicesTo(-1)
grep -q "navigateServicesTo(-1)" "$FILE" || { echo "FAIL: G key -> navigateServicesTo(-1) not found"; exit 1; }

# shortcuts panel documents G and shift+G
grep -q "Jump to first service" "$FILE" || { echo "FAIL: 'Jump to first service' not in shortcuts panel"; exit 1; }
grep -q "Jump to last service" "$FILE" || { echo "FAIL: 'Jump to last service' not in shortcuts panel"; exit 1; }

echo "PASS"
