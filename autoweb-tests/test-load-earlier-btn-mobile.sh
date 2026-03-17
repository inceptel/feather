#!/bin/bash
# test-load-earlier-btn-mobile.sh
# Tests: Load earlier messages button has 44px min-height touch target and full width on mobile
# Added: iteration 28

grep -q 'min-h-\[44px\]' /opt/feather/static/index.html || exit 1
grep -q 'w-full sm:w-auto' /opt/feather/static/index.html || exit 1
grep -q 'tap to load' /opt/feather/static/index.html || exit 1
exit 0
