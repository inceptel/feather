#!/bin/bash
# test-mobile-star-btn.sh
# Tests: mobile session header has a star button with correct id and 44px touch target

grep -q 'id="mobile-star-btn"' /opt/feather/static/index.html || exit 1
grep -q 'mobile-star-btn.*toggleStarSession\|toggleStarSession.*mobile-star-btn' /opt/feather/static/index.html || exit 1
grep -q 'min-h-\[44px\].*mobile-star-btn\|mobile-star-btn.*min-h-\[44px\]' /opt/feather/static/index.html || exit 1
exit 0
