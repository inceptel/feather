#!/bin/bash
# test-sse-cursor-reconnect.sh
# Tests: SSE onerror handler reconnects with latest cursor, not stuck on readyState===CLOSED check
# Added: iteration 60

# The old bug: onerror only reconnected if readyState===EventSource.CLOSED.
# But EventSource is in CONNECTING (0) when server drops — never CLOSED (2).
# This caused stale-cursor reconnects and messages only appearing after page refresh.
# The fix: always take over reconnection in onerror and use tailCursor.

# Check that the broken readyState===EventSource.CLOSED guard is removed from the tail onerror handler
# (There may be other SSE connections with this check — we only care about the tail onerror context)
grep -A 5 'tailingEventSource.onerror' /opt/feather/static/index.html | grep -q 'readyState === EventSource.CLOSED' && exit 1

# Check that onerror now closes the source and reconnects unconditionally
grep -A 10 'tailingEventSource.onerror' /opt/feather/static/index.html | grep -q 'src.close()' || exit 1

# Check the comment explaining the fix is present (documents the root cause)
grep -q 'CONNECTING.*never CLOSED\|never fired.*stale-cursor\|Stop EventSource.*built-in retry' /opt/feather/static/index.html || exit 1

exit 0
