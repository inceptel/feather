#!/bin/bash
# test-session-filter-toggle.sh
# Tests: Session filter toggle (Mine/Auto/All) exists in sidebar
# Added: iteration 37, updated to match current isAutowebSession() implementation

grep -q 'session-filter-bar' /opt/feather/static/index.html || exit 1
grep -q 'setSessionFilter' /opt/feather/static/index.html || exit 1
grep -q 'sf-mine' /opt/feather/static/index.html || exit 1
grep -q 'sf-auto' /opt/feather/static/index.html || exit 1
grep -q 'sf-all' /opt/feather/static/index.html || exit 1
grep -q 'isAutowebSession' /opt/feather/static/index.html || exit 1
exit 0
