#!/bin/bash
# test-stats-by-role-tooltip.sh
# Tests: fetchSessionStats sets metaEl.title with by_role breakdown

grep -q 'by_role' /opt/feather/static/index.html || exit 1
grep -q 'metaEl.title' /opt/feather/static/index.html || exit 1
exit 0
