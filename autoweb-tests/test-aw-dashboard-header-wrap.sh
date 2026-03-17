#!/bin/bash
# test-aw-dashboard-header-wrap.sh
# Tests: AW dashboard header has flex-wrap for mobile responsive layout
# Added: iteration 44

grep -q 'flex-wrap:wrap' /opt/feather/static/index.html || exit 1
# Title should be compact "Autoweb" not "Autoweb Dashboard"
grep -q '>Autoweb<' /opt/feather/static/index.html || exit 1
exit 0
