#!/bin/bash
# test-session-list-autoscroll.sh
# Tests: IntersectionObserver auto-trigger for load-more-sessions button
# Added: iteration 78

# Should have a loadMoreSessionsObserver variable and setupLoadMoreSessionsObserver function
grep -q 'loadMoreSessionsObserver' /opt/feather/static/index.html || exit 1
grep -q 'setupLoadMoreSessionsObserver' /opt/feather/static/index.html || exit 1
exit 0
