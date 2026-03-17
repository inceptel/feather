#!/bin/bash
# test-sse-onopen-stops-polling.sh
# Tests: When SSE opens, onopen callback stops history polling without killing the SSE connection
# Added: iteration 69

# The fix: tailingEventSource.onopen should stop historyPollInterval without calling stopSessionTailing()
# Check that onopen calls clearInterval on historyPollInterval
grep -q 'onopen.*=.*function\|\.onopen.*=' /opt/feather/static/index.html || exit 1

# Verify onopen stops history polling (clears interval) but does NOT also call stopSessionTailing
# The fix adds clearInterval(historyPollInterval) in the onopen handler
grep -A5 'tailingEventSource.onopen' /opt/feather/static/index.html | grep -q 'historyPollInterval\|stopPolling\|clearInterval' || exit 1

exit 0
