#!/bin/bash
# test-mobile-search-btn.sh
# Tests: mobile session header has search button that calls openChatSearch()

grep -q 'id="mobile-search-btn"' /opt/feather-dev/static/index.html || exit 1
grep -q 'mobile-search-btn.*openChatSearch\|openChatSearch.*mobile-search-btn' /opt/feather-dev/static/index.html || exit 1
exit 0
