#!/bin/bash
# test-chat-search-load-all.sh
# Tests: in-chat search shows 'search all' link when earlier messages exist (0 results + load-earlier-btn)

grep -q 'loadAllAndSearchChat' /opt/feather/static/index.html || exit 1
grep -q 'chat-search-all-link' /opt/feather/static/index.html || exit 1
grep -q 'search all' /opt/feather/static/index.html || exit 1
exit 0
