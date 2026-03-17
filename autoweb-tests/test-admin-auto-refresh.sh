#!/bin/bash
# test-admin-auto-refresh.sh
# Tests: admin.html has setInterval for auto-refresh and last-updated indicator

grep -q 'setInterval(refreshStatus, 30000)' /opt/feather-dev/static/admin/index.html || exit 1
grep -q 'last-updated' /opt/feather-dev/static/admin/index.html || exit 1
grep -q 'updateLastUpdatedDisplay' /opt/feather-dev/static/admin/index.html || exit 1
exit 0
