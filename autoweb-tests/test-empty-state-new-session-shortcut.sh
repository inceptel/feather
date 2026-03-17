#!/bin/bash
# test-empty-state-new-session-shortcut.sh
# Tests: Empty state shows 'N' (not 'Ctrl+N') as new session shortcut

grep -q '>N</kbd> New session' /opt/feather-dev/static/index.html || exit 1
exit 0
