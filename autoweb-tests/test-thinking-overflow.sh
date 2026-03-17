#!/bin/bash
# test-thinking-overflow.sh
# Tests: thinking block content has proper overflow-wrap CSS to prevent horizontal overflow
# Added: iteration 11

# Check that .thinking-content has overflow-wrap styling
grep -q 'thinking-content.*overflow-wrap' /opt/feather/static/index.html || \
grep -q '\.thinking-content {.*overflow-wrap' /opt/feather/static/index.html || \
grep -q '\.thinking-content{.*overflow-wrap' /opt/feather/static/index.html || exit 1

# Check that .thinking-block has overflow handling
grep -q 'thinking-block.*overflow' /opt/feather/static/index.html || exit 1

exit 0
