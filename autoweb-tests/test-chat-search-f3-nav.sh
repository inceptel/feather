#!/bin/bash
# test-chat-search-f3-nav.sh
# Tests: F3/Shift+F3 keyboard shortcuts navigate chat search results

grep -q "e.key === 'F3'" /opt/feather/static/index.html || exit 1
grep -q "chatSearchNav(e.shiftKey ? -1 : 1)" /opt/feather/static/index.html || exit 1
exit 0
