#!/bin/bash
# test-prev-unread-shortcut.sh
# Tests: P key shortcut for previous unread session exists in index.html
# Added: iteration 96

grep -q 'jumpToPrevUnreadSession' /opt/feather/static/index.html || exit 1
grep -q "e.key === 'p'" /opt/feather/static/index.html || exit 1
grep -q 'Previous unread session' /opt/feather/static/index.html || exit 1
exit 0
