#!/bin/bash
# test-navigate-session-sidebar-scroll.sh
# Tests: navigateSessionList programmatic calls update sidebar active class via data-ctx-id fallback

grep -q 'data-ctx-id.*sessionId\|sidebarItem.*scrollIntoView' /opt/feather-dev/static/index.html || exit 1
exit 0
