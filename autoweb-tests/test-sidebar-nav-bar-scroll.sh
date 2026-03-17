#!/bin/bash
# test-sidebar-nav-bar-scroll.sh
# Tests: Sidebar nav bar wraps on mobile so all buttons (including AV, AW) are always visible
# Updated: iteration 23 — wrap is preferred over scroll with hidden scrollbar

# Nav bar should have flex-wrap in its class list for wrapping
grep 'id="sidebar-nav-bar"' /opt/feather/static/index.html | grep -q 'flex-wrap\|flex.*wrap' || exit 1

# AW button should still exist
grep -qE 'id="autoweb-btn"|id="autoweb-dash-btn"' /opt/feather/static/index.html || exit 1

exit 0
