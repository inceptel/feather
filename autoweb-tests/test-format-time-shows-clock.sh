#!/bin/bash
# test-format-time-shows-clock.sh
# Tests: formatTime shows clock time (AM/PM) for today/yesterday sessions instead of "Xh"
# Added: iteration 79

# Check that the function uses toLocaleTimeString with hour12 for today's sessions
grep -q "toLocaleTimeString.*hour12.*true" /opt/feather/static/index.html || exit 1
# Check that today's group still shows actual time (not just hours diff)
grep -A 20 "function formatTime" /opt/feather/static/index.html | grep -q "today\b" || exit 1
exit 0
