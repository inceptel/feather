#!/bin/bash
# test-session-header-tooltip.sh
# Tests: desktop session header title tooltip shows full title, not static 'Double-click to rename'
# Added: iteration 81

# The updateDesktopSessionHeader function should set titleEl.title = title + '\n(double-click to rename)'
grep -q "titleEl.title = title" /opt/feather/static/index.html || exit 1
exit 0
