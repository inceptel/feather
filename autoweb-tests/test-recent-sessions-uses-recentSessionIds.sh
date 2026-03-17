#!/bin/bash
# test-recent-sessions-uses-recentSessionIds.sh
# Tests: recent-sessions-cards uses recentSessionIds to find sessions by ID

# Should use recentSessionIds.map(id => allSessions.find(...)) pattern
grep -q 'recentSessionIds' /opt/feather-dev/static/index.html && \
grep -A3 'recently visited sessions' /opt/feather-dev/static/index.html | grep -q 'recentSessionIds' || exit 1
exit 0
