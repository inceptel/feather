#!/bin/bash
# test-empty-session-filter-msg.sh
# Tests: Empty session list shows contextual message based on active filter
# Added: iteration 42

# Check that the mine filter empty state has a "Show all sessions" link
grep -q "No manual sessions in this project" /opt/feather/static/index.html || exit 1
grep -q "setSessionFilter.*all" /opt/feather/static/index.html || exit 1
# Check that search empty state shows the query
grep -q 'No sessions matching' /opt/feather/static/index.html || exit 1
exit 0
