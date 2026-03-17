#!/bin/bash
# test-load-earlier-autoscroll.sh
# Tests: IntersectionObserver is set up for auto-triggering load-earlier on scroll
# Added: iteration 75

grep -q 'setupLoadEarlierObserver' /opt/feather/static/index.html || exit 1
grep -q 'IntersectionObserver' /opt/feather/static/index.html || exit 1
exit 0
