#!/bin/bash
# test-formattime-year.sh
# Tests: formatTime shows year for sessions older than 1 year
# Added: iteration 77+

# The formatTime function should include year: 'numeric' for dates >= 365 days old
grep -q "days >= 365.*year.*numeric\|year.*numeric.*days >= 365" /opt/feather/static/index.html || exit 1
exit 0
