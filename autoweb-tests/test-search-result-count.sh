#!/bin/bash
# test-search-result-count.sh
# Tests: search result count shows 'N of M results' when total > limit

# Check frontend code uses data.total for accurate count display
grep -q '_searchTotal = data.total' /opt/feather/static/index.html || exit 1
grep -q 'total > n' /opt/feather/static/index.html || exit 1
grep -q 'of \${total} results' /opt/feather/static/index.html || exit 1
exit 0
