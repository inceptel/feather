#!/bin/bash
# test-jump-next-unread.sh
# Tests: jumpToNextUnreadSession function exists and U key shortcut is registered
# Added: iteration 91

grep -q 'function jumpToNextUnreadSession' /opt/feather/static/index.html || exit 1
grep -q "key === 'u'" /opt/feather/static/index.html || exit 1
grep -q 'Next unread session' /opt/feather/static/index.html || exit 1
exit 0
