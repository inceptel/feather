#!/bin/bash
# test-mobile-terminal-height.sh
# Tests: Mobile terminal container has reduced min-height for better space usage
# Added: iteration 35

# Check that mobile media query reduces terminal container min-height
grep -q 'min-height:.*80px' /opt/feather/static/index.html || exit 1
# Check that mobile max-height for terminal panel is reasonable (≤180px)
grep -q 'max-height:.*180px' /opt/feather/static/index.html || exit 1
exit 0
