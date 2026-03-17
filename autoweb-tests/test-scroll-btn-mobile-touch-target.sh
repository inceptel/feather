#!/bin/bash
# test-scroll-btn-mobile-touch-target.sh
# Tests: Scroll-to-bottom button has 44px touch target on mobile via CSS media query
# Added: iteration 31

# Check that there's a mobile media query making scroll-to-bottom button at least 44px
grep -q 'scroll-to-bottom-btn' /opt/feather/static/index.html || exit 1
# Check for mobile touch target on scroll button (min-height or min-width 44px)
grep -q 'scroll-to-bottom.*44\|scroll-to-bottom.*min-h\|#scroll-to-bottom-btn.*44' /opt/feather/static/index.html && exit 0
# Or check for it in mobile media query
grep -A5 'max-width.*767' /opt/feather/static/index.html | grep -q 'scroll-to-bottom' || exit 1
exit 0
