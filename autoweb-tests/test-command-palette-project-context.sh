#!/bin/bash
# test-command-palette-project-context.sh
# Tests: command palette Go to: items include project folder context (projName / title format)
# Added: iteration 100

# Check that getFilteredCommands uses FOLDERS.find to get projName
grep -q "projName.*FOLDERS.find.*s\.project" /opt/feather/static/index.html || exit 1

# Check that session/recent items use projName prefix with getSessionTitle
grep -q "projName.*getSessionTitle" /opt/feather/static/index.html || exit 1

# Check that group headers distinguish Recent/Session/Commands sections
grep -q "GROUP_LABELS" /opt/feather/static/index.html || exit 1

exit 0
