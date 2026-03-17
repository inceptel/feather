#!/bin/bash
# test-mobile-browse-sessions-btn.sh
# Tests: Mobile empty state has a Browse Sessions button that opens sidebar

grep -q "Browse Sessions" /opt/feather/static/index.html || exit 1
grep -q 'onclick="toggleSidebar()".*md:hidden\|md:hidden.*onclick="toggleSidebar()"' /opt/feather/static/index.html || exit 1
exit 0
