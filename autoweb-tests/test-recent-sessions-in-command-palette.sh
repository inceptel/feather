#!/bin/bash
# test-recent-sessions-in-command-palette.sh
# Tests: when command palette opens with empty query, recent sessions are shown
# Added: iteration 98

# Check that recentSessionIds is tracked in localStorage
grep -q 'recentSessionIds' /opt/feather/static/index.html || exit 1
# Check that empty-query path shows recent sessions (group: 'recent' replaces old 'Recent:' prefix)
grep -q "group: 'recent'" /opt/feather/static/index.html || exit 1
exit 0
