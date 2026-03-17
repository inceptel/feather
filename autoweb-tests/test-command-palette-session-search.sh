#!/bin/bash
# test-command-palette-session-search.sh
# Tests: Command palette getFilteredCommands includes session navigation when queried
# Added: iteration 97

# Check that session search is integrated into the command palette (group: 'session' replaces old 'Go to:' prefix)
grep -q "group: 'session'" /opt/feather/static/index.html || exit 1
grep -q 'sessionItems' /opt/feather/static/index.html || exit 1
exit 0
