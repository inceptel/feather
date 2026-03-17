#!/bin/bash
# test-search-respects-filter.sh
# Tests: when searchApiResults !== null, filter mode (mine/auto/all) is applied to search results

grep -q "sessionFilterMode === 'mine'" /opt/feather-dev/static/index.html || exit 1
# Ensure the filter is applied inside the searchApiResults block (not just for normal browsing)
# The pattern should appear at least twice (once in browsing, once in search results)
count=$(grep -c "sessionFilterMode === 'mine'" /opt/feather-dev/static/index.html)
[ "$count" -ge 2 ] || exit 1
# Ensure the "Search all sessions" fallback link exists for filtered empty state
grep -q "Search all sessions" /opt/feather-dev/static/index.html || exit 1
exit 0
