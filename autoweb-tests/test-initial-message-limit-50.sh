#!/bin/bash
# test-initial-message-limit-50.sh
# Tests: INITIAL_LIMIT for session history is 50 (not 200) to reduce memory usage on large sessions
# Added: iteration 60

grep -q 'const INITIAL_LIMIT = 50;' /opt/feather/static/index.html || exit 1
exit 0
