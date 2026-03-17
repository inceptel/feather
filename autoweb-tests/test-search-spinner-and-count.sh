#!/bin/bash
# test-search-spinner-and-count.sh
# Tests: search input shows loading spinner and result count when API search runs

grep -q 'search-spinner' /opt/feather/static/index.html || exit 1
grep -q 'search-result-count' /opt/feather/static/index.html || exit 1
exit 0
