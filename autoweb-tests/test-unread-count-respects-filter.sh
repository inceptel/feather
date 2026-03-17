#!/bin/bash
# test-unread-count-respects-filter.sh
# Tests: unread count uses filter-specific sessions, not allSessions always
# Added: iter 83

# The unread count should use a filtered base derived from sessionFilterMode
grep -q 'unreadBase.*sessionFilterMode\|sessionFilterMode.*unreadBase\|unreadBase.*mine\|mine.*unreadBase' /opt/feather/static/index.html || exit 1
exit 0
