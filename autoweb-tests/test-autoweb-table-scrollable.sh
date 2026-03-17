#!/bin/bash
# test-autoweb-table-scrollable.sh
# Tests: AW dashboard table container has overflow-x:auto for mobile scrolling
# Added: iteration 22

# The autoweb results table container should allow horizontal scrolling on mobile
grep -q 'overflow-x:auto' /opt/feather/static/index.html || exit 1
# The table should have a min-width so it doesn't collapse on narrow screens
grep -q 'min-width:' /opt/feather/static/index.html | grep -q 'autoweb-results-table\|autoweb' 2>/dev/null
# Simpler check: the table should have min-width set
grep -q 'min-width:600px\|min-width: 600px' /opt/feather/static/index.html || exit 1
exit 0
