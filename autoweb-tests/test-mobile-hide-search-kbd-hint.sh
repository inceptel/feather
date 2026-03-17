#!/bin/bash
# test-mobile-hide-search-kbd-hint.sh
# Tests: search shortcut hint (/) is hidden on mobile via CSS
# Added: iteration 36

# Check that the mobile media query hides #search-shortcut-hint
grep -q '#search-shortcut-hint { display: none' /opt/feather/static/index.html || exit 1
# Ensure the hint element still exists in HTML (just hidden on mobile)
grep -q 'id="search-shortcut-hint"' /opt/feather/static/index.html || exit 1
exit 0
