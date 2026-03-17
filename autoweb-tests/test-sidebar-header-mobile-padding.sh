#!/bin/bash
# test-sidebar-header-mobile-padding.sh
# Tests: Sidebar header has extra left padding on mobile to avoid hamburger overlap
# Added: iteration 15

grep -q 'pl-14 md:pl-3' /opt/feather/static/index.html || exit 1
exit 0
