#!/bin/bash
# test-aw-trading-url.sh
# Tests: AW dashboard trading tab uses /api/autoweb-results/trading (not broken dashboards path)
# Added: iteration 65

grep -q "'/api/autoweb-results/trading'" /opt/feather/static/index.html || \
grep -q '"/api/autoweb-results/trading"' /opt/feather/static/index.html || exit 1
exit 0
