#!/bin/bash
# test-bottom-bar-scroll-indicator.sh
# Tests: Bottom nav bar has a scroll fade indicator for mobile overflow
# Added: iteration 20

# Check that the bottom bar has an id for targeting
grep -q 'id="sidebar-nav-bar"' /opt/feather/static/index.html || exit 1
# Check that there's CSS for the scroll fade indicator
grep -q 'sidebar-nav-bar' /opt/feather/static/index.html | grep -q 'after\|fade\|gradient' /opt/feather/static/index.html || exit 1
exit 0
