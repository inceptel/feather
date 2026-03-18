#!/bin/bash
# test-admin-filter-summary.sh
# Tests: admin service filter updates summary count when filter is active (shows "filtered" label)

grep -q 'filtered)' /opt/feather-dev/static/admin/index.html || exit 1
grep -q 'visibleRunning' /opt/feather-dev/static/admin/index.html || exit 1
exit 0
