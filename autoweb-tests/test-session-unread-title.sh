#!/bin/bash
# test-session-unread-title.sh
# Tests: sessionListUnreadCount drives the page title (N) prefix for session-level unread

grep -q 'sessionListUnreadCount' /opt/feather-dev/static/index.html || exit 1
grep -q 'sessionListUnreadCount = unreadCount' /opt/feather-dev/static/index.html || exit 1
exit 0
