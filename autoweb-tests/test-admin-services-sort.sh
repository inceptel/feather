#!/bin/bash
# test-admin-services-sort.sh
# Tests: Admin services are sorted with non-running first (stopped services bubble to top)

grep -q 'status === .RUNNING. ? 1 : 0' /opt/feather-dev/static/admin/index.html || exit 1
grep -q 'localeCompare' /opt/feather-dev/static/admin/index.html || exit 1
exit 0
