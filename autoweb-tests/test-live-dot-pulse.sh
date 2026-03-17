#!/bin/bash
# test-live-dot-pulse.sh
# Tests: active session dots in session list use live-dot pulse animation class

grep -q 'bg-apple-9 shadow-sm shadow-apple-9/50 live-dot shrink-0' /opt/feather-dev/static/index.html || exit 1
exit 0
