#!/bin/bash
# test-sort-relevance-in-search.sh
# Tests: sort button shows 'Relevance' when searchApiResults !== null

grep -q 'sortLabelEl.textContent = .Relevance' /opt/feather-dev/static/index.html || exit 1
grep -q 'pointerEvents.*none' /opt/feather-dev/static/index.html || exit 1
exit 0
