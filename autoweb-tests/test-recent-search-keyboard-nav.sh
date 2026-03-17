#!/bin/bash
# test-recent-search-keyboard-nav.sh
# Tests: Recent search dropdown keyboard navigation with ArrowDown/Up/Enter

grep -q '_recentSearchHighlightIdx' /opt/feather/static/index.html || exit 1
grep -q 'renderRecentSearchDropdown' /opt/feather/static/index.html || exit 1
grep -q 'dropdownVisible.*ArrowDown.*ArrowUp.*Enter' /opt/feather/static/index.html || exit 1
exit 0
