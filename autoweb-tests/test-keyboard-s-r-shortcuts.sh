#!/bin/bash
# test-keyboard-s-r-shortcuts.sh
# Tests: S key for star/unstar and R key for rename are in keydown handler and shortcuts modal
# Added: iter 73

# Check S key handler exists in keydown listener
grep -q "key === 's'" /opt/feather/static/index.html || exit 1
grep -q "toggleStarSession.*currentSessionId" /opt/feather/static/index.html || exit 1

# Check R key handler exists in keydown listener
grep -q "key === 'r'" /opt/feather/static/index.html || exit 1
grep -q "renameCurrentSession" /opt/feather/static/index.html || exit 1

# Check shortcuts modal shows S and R
grep -q "Star/unstar session" /opt/feather/static/index.html || exit 1
grep -q "Rename session" /opt/feather/static/index.html || exit 1

exit 0
