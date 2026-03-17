#!/bin/bash
# test-version-indicator-multi-source.sh
# Tests: version indicator script uses Promise.all to fetch from multiple autoweb sources
# Added: iter 80

# Check that the version indicator script uses Promise.all with multiple sources
# The version indicator script is at the end of the file (after line 7240)
TOTAL=$(wc -l < /opt/feather/static/index.html)
VERSION_SECTION_START=$((TOTAL - 50))

# Extract the version indicator section (last 50 lines)
TAIL=$(tail -50 /opt/feather/static/index.html)

# Must have Promise.all in the version indicator section
echo "$TAIL" | grep -q 'Promise.all' || exit 1

# Must reference feather and trading endpoints (frontend removed — maps to same file as feather, caused double-counting)
echo "$TAIL" | grep -q 'autoweb-results/feather' || exit 1
echo "$TAIL" | grep -q 'autoweb-results/trading' || exit 1

exit 0
