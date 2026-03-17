#!/bin/bash
# test-mark-all-read-shortcut.sh
# Tests: A key shortcut for markAllSessionsRead is present in index.html
# Added: iteration 93

grep -q "key === 'a'" /opt/feather/static/index.html || exit 1
grep -q "markAllSessionsRead" /opt/feather/static/index.html || exit 1
grep -q "Mark all sessions read" /opt/feather/static/index.html || exit 1
# Verify it's in shortcuts modal
grep -q "Mark all sessions read.*A\|A.*Mark all sessions read" /opt/feather/static/index.html || exit 1
exit 0
