#!/bin/bash
# test-desktop-header-search-btn.sh
# Tests: desktop session header has a search button with id=desktop-search-btn that calls openChatSearch()
# Added: iteration 85

grep -q 'id="desktop-search-btn"' /opt/feather/static/index.html || exit 1
grep -q 'openChatSearch()' /opt/feather/static/index.html | head -1 || true
grep -q 'desktop-search-btn.*openChatSearch\|openChatSearch.*desktop-search-btn' /opt/feather/static/index.html || exit 1
exit 0
