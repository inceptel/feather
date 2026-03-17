#!/bin/bash
# test-search-load-more.sh
# Tests: search results have a load-more button when total > shown

grep -q 'load-more-search-btn' /opt/feather-dev/static/index.html || exit 1
grep -q 'loadMoreSearchResults' /opt/feather-dev/static/index.html || exit 1
grep -q '_searchLimit' /opt/feather-dev/static/index.html || exit 1
exit 0
