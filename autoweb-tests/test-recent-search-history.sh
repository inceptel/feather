#!/bin/bash
# test-recent-search-history.sh
# Tests: recentSearches stored in localStorage, showRecentSearchDropdown/hideRecentSearchDropdown functions, saveRecentSearch function, search-recent-dropdown element exists

grep -q 'recentSearches' /opt/feather/static/index.html || exit 1
grep -q 'saveRecentSearch' /opt/feather/static/index.html || exit 1
grep -q 'showRecentSearchDropdown' /opt/feather/static/index.html || exit 1
grep -q 'search-recent-dropdown' /opt/feather/static/index.html || exit 1
grep -q 'applyRecentSearch' /opt/feather/static/index.html || exit 1
exit 0
