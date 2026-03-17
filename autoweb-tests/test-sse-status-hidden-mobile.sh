#!/bin/bash
# test-sse-status-hidden-mobile.sh
# Tests: SSE status text has hidden md:inline classes to hide on mobile
# Added: iteration 40

grep -q 'id="sse-status".*hidden md:inline' /opt/feather/static/index.html || exit 1
grep -q 'sse-status.*className.*hidden md:inline' /opt/feather/static/index.html || exit 1
exit 0
