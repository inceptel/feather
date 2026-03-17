#!/bin/bash
# test-sort-shortcut-o.sh
# Tests: O keyboard shortcut for cycling session sort order exists
# Added: iteration 88

grep -q "key === 'o'" /opt/feather/static/index.html || exit 1
grep -q "cycleSessionSort" /opt/feather/static/index.html || exit 1
exit 0
