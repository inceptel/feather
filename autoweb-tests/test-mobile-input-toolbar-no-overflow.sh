#!/bin/bash
# test-mobile-input-toolbar-no-overflow.sh
# Tests: Status text is hidden on mobile to prevent input toolbar overflow
# Added: iteration 19

# Check that status text has a hidden class for small screens
grep -q 'id="status"' /opt/feather/static/index.html || exit 1
# The status span should have hidden/sm:inline or similar responsive class to hide on mobile
grep 'id="status"' /opt/feather/static/index.html | grep -qE 'hidden\s+sm:inline|hidden\s+sm:block' || exit 1
exit 0
