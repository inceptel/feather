#!/bin/bash
# test-last-active-no-ago.sh
# Tests: "Last active" pulse insight does not append " ago" (wrong for clock times)

grep -q 'Last active ${formatTime(lastSession.lastUpdated)}`' /opt/feather/static/index.html || exit 1
# Must NOT have the old buggy "ago" suffix
grep -q 'Last active ${formatTime(lastSession.lastUpdated)} ago`' /opt/feather/static/index.html && exit 1
exit 0
