#!/bin/bash
# test-session-list-skeleton.sh
# Tests: loadSessions() shows skeleton loading state when allSessions is empty
# Added: iteration 79+

# Check that skeleton CSS classes are defined
grep -q 'skeleton-line\|skeleton-block' /opt/feather/static/index.html || exit 1

# Check that skeleton HTML is generated in loadSessions when no sessions yet
grep -q 'skeleton.*session\|session.*skeleton\|allSessions\.length.*0.*skeleton\|sessions-skeleton' /opt/feather/static/index.html || exit 1

exit 0
