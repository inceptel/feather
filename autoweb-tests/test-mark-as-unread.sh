#!/bin/bash
# test-mark-as-unread.sh
# Tests: context menu has markSessionUnread function and ctxMarkUnread function

grep -q 'function markSessionUnread' /opt/feather/static/index.html || exit 1
grep -q 'function ctxMarkUnread' /opt/feather/static/index.html || exit 1
grep -q 'ctxMarkUnread()' /opt/feather/static/index.html || exit 1
grep -q 'Mark as unread' /opt/feather/static/index.html || exit 1
exit 0
