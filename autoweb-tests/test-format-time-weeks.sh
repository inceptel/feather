#!/bin/bash
# test-format-time-weeks.sh
# Tests: formatTime shows date (e.g. "Mar 15") for sessions >= 7 days old
# Updated: iteration 76 — changed from weeks suffix (2w) to date format (Mar 15)

# The formatTime function should contain week logic (7 * 86400000)
grep -A 20 'function formatTime' /opt/feather/static/index.html | grep -q '7 \* 86400000' || exit 1
# And should use month/day format for old sessions (not ${weeks}w anymore)
grep -A 20 'function formatTime' /opt/feather/static/index.html | grep -q "month.*short" || exit 1
exit 0
