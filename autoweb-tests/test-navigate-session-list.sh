#!/bin/bash
# test-navigate-session-list.sh
# Tests: [ and ] keyboard shortcuts navigate session list (navigateSessionList function exists, command palette entries, shortcuts modal entry)

grep -q 'function navigateSessionList' /opt/feather/static/index.html || exit 1
grep -q "Next session in list" /opt/feather/static/index.html || exit 1
grep -q "Previous session in list" /opt/feather/static/index.html || exit 1
grep -q "Next / prev session in list" /opt/feather/static/index.html || exit 1
grep -q "navigateSessionList(e.key === ']' ? 1 : -1)" /opt/feather/static/index.html || exit 1
exit 0
