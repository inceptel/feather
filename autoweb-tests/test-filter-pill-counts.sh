#!/bin/bash
# test-filter-pill-counts.sh
# Tests: Session filter pills show counts (Mine N, Auto N, All N)
# Added: iteration 43

# Check that renderSessions updates filter pill textContent with counts
grep -q "sfMine.*textContent.*'Mine'" /opt/feather/static/index.html || exit 1
grep -q "sfAuto.*textContent.*'Auto'" /opt/feather/static/index.html || exit 1
grep -q "sfAll.*textContent.*'All'" /opt/feather/static/index.html || exit 1
grep -q "mineCount.*allSessions.filter" /opt/feather/static/index.html || exit 1
exit 0
