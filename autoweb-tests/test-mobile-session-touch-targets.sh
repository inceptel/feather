#!/bin/bash
# test-mobile-session-touch-targets.sh
# Tests: session list items have 44px min-height on mobile (max-width: 767px)
# Added: iteration 23

# Check that mobile media query includes min-height: 44px for session-item
grep -q 'session-item.*min-height.*44px\|\.session-item[^}]*min-height: *44px' /opt/feather/static/index.html || \
grep -A5 'max-width: 767px' /opt/feather/static/index.html | grep -q 'session-item.*44px\|\.session-item' || exit 1
exit 0
