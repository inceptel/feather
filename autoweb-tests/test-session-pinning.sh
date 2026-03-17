#!/bin/bash
# test-session-pinning.sh
# Tests: pinnedSessions Set from localStorage, togglePinSession function, Pinned group header in session list, Pin/Unpin in context menu

grep -q 'pinnedSessions' /opt/feather/static/index.html || exit 1
grep -q 'feather-pinnedSessions' /opt/feather/static/index.html || exit 1
grep -q 'togglePinSession' /opt/feather/static/index.html || exit 1
grep -q 'ctxPin' /opt/feather/static/index.html || exit 1
grep -q 'Pin to top' /opt/feather/static/index.html || exit 1
grep -q 'Pinned' /opt/feather/static/index.html || exit 1
exit 0
