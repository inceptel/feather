#!/bin/bash
# test-version-indicator-hidden-mobile.sh
# Tests: Version indicator is hidden on mobile (max-width: 767px)
# Added: iteration 43

grep -q 'max-width: 767px' /opt/feather/static/index.html || exit 1
grep -q '#autoweb-version-indicator.*display.*none' /opt/feather/static/index.html || exit 1
exit 0
