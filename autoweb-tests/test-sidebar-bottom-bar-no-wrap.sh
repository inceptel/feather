#!/bin/bash
# test-sidebar-bottom-bar-no-wrap.sh
# Tests: Bottom bar in sidebar should use flex-wrap so nav pills are visible

# The bottom bar should have flex-wrap
grep 'border-t border-smoke-4 flex' /opt/feather/static/index.html | grep -q 'flex-wrap' || exit 1

exit 0
