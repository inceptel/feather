#!/bin/bash
# test-sidebar-bottom-bar-no-wrap.sh
# Tests: Bottom bar in sidebar should use flex-wrap so all nav pills are visible (especially AW button)
# Updated: iteration 20 — changed from scroll to wrap to fix CRITICAL AW button visibility issue

# The bottom bar should have flex-wrap to ensure all buttons (including AW) are visible
grep 'border-t border-smoke-4 flex' /opt/feather/static/index.html | grep -q 'flex-wrap' || exit 1

# The AW button should exist in the sidebar
grep -qE 'id="autoweb-btn"|id="autoweb-dash-btn"' /opt/feather/static/index.html || exit 1

exit 0
