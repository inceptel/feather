#!/bin/bash
# test-admin-filter-reapply.sh
# Tests: renderServices re-applies active filter after refresh

grep -q 'activeFilter' /opt/feather-dev/static/admin/index.html || exit 1
grep -q 'if (activeFilter) filterServices' /opt/feather-dev/static/admin/index.html || exit 1
exit 0
