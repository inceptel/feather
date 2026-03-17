#!/bin/bash
# test-cycle-session-filter-shortcut.sh
# Tests: cycleSessionFilter() function exists and 'M' key handler calls it
# Added: iteration 78

grep -q 'function cycleSessionFilter' /opt/feather/static/index.html || exit 1
grep -q "e.key === 'm'" /opt/feather/static/index.html || exit 1
grep -q "cycleSessionFilter()" /opt/feather/static/index.html || exit 1
grep -q "Cycle session filter" /opt/feather/static/index.html || exit 1
exit 0
