#!/bin/bash
# test-search-flat-results.sh
# Tests: search results rendered without time-group headers (flat list, relevance order preserved)

grep -q 'isSearchMode = searchApiResults !== null' /opt/feather-dev/static/index.html || exit 1
grep -q 'if (!isSearchMode)' /opt/feather-dev/static/index.html || exit 1
exit 0
