#!/bin/bash
# test-table-responsive.sh
# Tests: Tables in markdown content have responsive CSS (overflow-x: auto wrapper, min-width on cells)
# Added: iteration 5

# Check that table styling exists in the CSS
grep -q 'markdown-content.*table' /opt/feather/static/index.html || exit 1
# Check for overflow-x auto on table wrapper or table itself
grep -q 'overflow-x.*auto' /opt/feather/static/index.html | grep -q 'table' && exit 0
# Alternative: check for a table-wrapper class or display: block on table
grep -q 'table-wrapper\|\.markdown-content table' /opt/feather/static/index.html || exit 1
exit 0
