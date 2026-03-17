#!/bin/bash
# test-shortcuts-modal-scrollable.sh
# Tests: shortcuts modal has max-height and overflow-y:auto for scroll on small screens
# Added: iteration 94

grep -q 'max-height:85vh' /opt/feather/static/index.html || exit 1
grep -q 'overflow-y:auto' /opt/feather/static/index.html || exit 1
exit 0
