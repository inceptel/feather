#!/bin/bash
# test-version-indicator-no-frontend-double-count.sh
# Tests: version indicator fetches only feather+trading (not frontend which maps to same file as feather)

grep -q "maps to same file as 'feather'" /opt/feather-dev/static/index.html || exit 1
# Should NOT fetch frontend in the version indicator Promise.all
! grep -A5 "Fetch live keeps count" /opt/feather-dev/static/index.html | grep -q "autoweb-results/frontend" || exit 1
exit 0
