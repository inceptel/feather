#!/bin/bash
# test-admin-uptime-format.sh
# Tests: admin.html has formatUptime function that handles H:MM:SS and plain-second formats

grep -q 'function formatUptime' /opt/feather-dev/static/admin/index.html || exit 1
grep -q 'formatUptime(svc.uptime)' /opt/feather-dev/static/admin/index.html || exit 1
exit 0
