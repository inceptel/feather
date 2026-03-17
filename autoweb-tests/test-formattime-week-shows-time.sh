#!/bin/bash
# test-formattime-week-shows-time.sh
# Tests: formatTime for "This Week" sessions shows weekday + time (e.g. "Mon 3:45 PM" not just "Mon")

grep -q "weekday: 'short' }) + ' ' + d.toLocaleTimeString" /opt/feather/static/index.html || exit 1
exit 0
