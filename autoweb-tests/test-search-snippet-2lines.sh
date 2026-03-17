#!/bin/bash
# test-search-snippet-2lines.sh
# Tests: search snippets use line-clamp-2 (2-line display) not truncate (single-line)

grep -q 'line-clamp-2.*leading-tight mt-0.5' /opt/feather-dev/static/index.html || exit 1
# Ensure old single-line truncate style is gone from snippet
grep -q 'text-\[9px\] text-smoke-6 truncate.*italic' /opt/feather-dev/static/index.html && exit 1
exit 0
