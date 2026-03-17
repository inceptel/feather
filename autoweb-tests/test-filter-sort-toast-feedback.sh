#!/bin/bash
# test-filter-sort-toast-feedback.sh
# Tests: cycleSessionFilter shows toast with filter name; cycleSessionSort shows toast with sort label
# Added: iteration 104

grep -q "Filter: " /opt/feather/static/index.html || exit 1
grep -q "Sort: " /opt/feather/static/index.html || exit 1
grep -q "showToast.*Filter.*labels\[next\]" /opt/feather/static/index.html || exit 1
grep -q "showToast.*Sort.*SESSION_SORT_LABELS" /opt/feather/static/index.html || exit 1
exit 0
