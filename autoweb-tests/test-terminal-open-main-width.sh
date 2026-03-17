#!/bin/bash
# test-terminal-open-main-width.sh
# Tests: When terminal is open, main element should not use flex:none which causes overflow
# Added: iteration 24

# Check that body.terminal-open main does NOT have flex: none
# It should use flex: 1 or similar to respect sidebar width
grep -q 'body\.terminal-open main.*flex: none' /opt/feather/static/index.html && exit 1
exit 0
