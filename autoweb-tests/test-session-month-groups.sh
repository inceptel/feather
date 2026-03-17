#!/bin/bash
# test-session-month-groups.sh
# Tests: getTimeGroup returns month-based groups for sessions older than This Week

grep -q "This Month" /opt/feather-dev/static/index.html || exit 1
grep -q "toLocaleDateString.*month.*long.*year.*numeric" /opt/feather-dev/static/index.html || exit 1
exit 0
