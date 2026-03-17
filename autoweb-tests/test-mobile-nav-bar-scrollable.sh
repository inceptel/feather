#!/bin/bash
# test-mobile-nav-bar-scrollable.sh
# Tests: On mobile, sidebar nav bar should wrap so all buttons (including AV, AW) are visible
# Updated: iteration 23 — changed from nowrap/scroll to wrap for button visibility

# There should be a mobile media query that sets the nav bar to wrap
grep -q 'sidebar-nav-bar' /opt/feather/static/index.html || exit 1
grep -A5 'max-width.*767' /opt/feather/static/index.html | grep -q 'flex-wrap.*wrap' || exit 1

exit 0
