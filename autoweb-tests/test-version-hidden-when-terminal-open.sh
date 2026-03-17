#!/bin/bash
# test-version-hidden-when-terminal-open.sh
# Tests: version indicator is hidden when terminal panel is open
# Added: iteration 35

# Check that the CSS rule exists to hide version indicator when terminal is open
grep -q 'body.terminal-open #autoweb-version-indicator' /opt/feather/static/index.html || exit 1
grep -q 'display: none' /opt/feather/static/index.html || exit 1
exit 0
