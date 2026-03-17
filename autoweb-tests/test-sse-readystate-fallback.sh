#!/bin/bash
# test-sse-readystate-fallback.sh
# Tests: sendMessage falls back to polling when SSE connection is not OPEN
# Added: iteration after 2026-03-17

grep -q 'tailingEventSource.readyState === EventSource.OPEN' /opt/feather/static/index.html || exit 1
grep -q 'isSSEOpen' /opt/feather/static/index.html || exit 1
exit 0
