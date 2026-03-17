#!/bin/bash
# test-autoweb-button.sh
# Tests: Autoweb button exists in sidebar and modal/panel markup exists
# Added: iteration 6

# Check the AW button exists
grep -q 'toggleAutowebPanel\|autoweb-panel\|autoweb-modal' /opt/feather/static/index.html || exit 1
# Check for the results table container
grep -q 'autoweb-results-table\|autoweb-results-body' /opt/feather/static/index.html || exit 1
# Check for the nav pill button
grep -q 'AW</button>' /opt/feather/static/index.html || exit 1
exit 0
