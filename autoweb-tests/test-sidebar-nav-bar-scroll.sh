#!/bin/bash
# test-sidebar-nav-bar-scroll.sh
# Tests: Sidebar nav bar wraps on mobile so all buttons are always visible

# Nav bar should have flex-wrap in its class list for wrapping
grep 'id="sidebar-nav-bar"' /opt/feather/static/index.html | grep -q 'flex-wrap\|flex.*wrap' || exit 1

exit 0
