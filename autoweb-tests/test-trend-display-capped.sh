#!/bin/bash
# test-trend-display-capped.sh
# Tests: trend display uses multiplier format for large changes (3x) instead of huge percentages
# Added: iteration 48

# The code should use "Nx last wk" format for ratios >= 3, not "+N% vs last wk"
grep -q 'ratio >= 3' /opt/feather/static/index.html || exit 1
grep -q 'x last wk' /opt/feather/static/index.html || exit 1
exit 0
