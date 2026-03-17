#!/bin/bash
# test-swipe-sidebar-gesture.sh
# Tests: swipe gesture handler exists for mobile sidebar open/close

grep -q 'swipeTouchStartX\|touchstart.*swipe\|handleSwipeStart\|swipeStartX' /opt/feather/static/index.html || exit 1
exit 0
