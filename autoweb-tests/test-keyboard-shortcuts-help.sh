#!/bin/bash
# test-keyboard-shortcuts-help.sh
# Tests: keyboard shortcuts help modal exists in HTML
# Added: iteration 14

# Check that the shortcuts help modal HTML exists
grep -q 'shortcuts-modal' /opt/feather/static/index.html || exit 1
# Check that it lists the known shortcuts
grep -q 'Focus search' /opt/feather/static/index.html || exit 1
grep -q 'Focus input' /opt/feather/static/index.html || exit 1
grep -q 'Toggle terminal' /opt/feather/static/index.html || exit 1
# Check the "?" key triggers it
grep -q "key === '?'" /opt/feather/static/index.html || exit 1
exit 0
