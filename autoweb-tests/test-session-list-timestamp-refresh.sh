#!/bin/bash
# test-session-list-timestamp-refresh.sh
# Tests: setInterval refreshes session list timestamps every 60s

grep -q "setInterval.*renderSessions" /opt/feather-dev/static/index.html || exit 1
grep -q "60000" /opt/feather-dev/static/index.html || exit 1
exit 0
