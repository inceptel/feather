#!/bin/bash
# test-aw-dashboard-frontend-tab.sh
# Tests: AW dashboard has a "Frontend" tab button and _awUrls includes frontend endpoint
# Added: iteration 70

grep -q "aw-tab-frontend" /opt/feather/static/index.html || exit 1
grep -q "frontend.*api/autoweb-results/frontend\|api/autoweb-results/frontend.*frontend" /opt/feather/static/index.html || exit 1
exit 0
