#!/bin/bash
# test-search-infinite-scroll.sh
# Tests: search results auto-load via IntersectionObserver (setupLoadMoreSearchObserver)

grep -q 'setupLoadMoreSearchObserver' /opt/feather/static/index.html || exit 1
grep -q 'loadMoreSearchObserver' /opt/feather/static/index.html || exit 1
grep -q "document.getElementById('load-more-search-btn')" /opt/feather/static/index.html || exit 1
exit 0
