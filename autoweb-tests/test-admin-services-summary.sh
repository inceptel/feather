#!/bin/bash
# test-admin-services-summary.sh
# Tests: Admin dashboard services header shows running count summary

grep -q 'services-summary' /opt/feather-dev/static/admin/index.html || exit 1
grep -q 'runningCount' /opt/feather-dev/static/admin/index.html || exit 1
exit 0
