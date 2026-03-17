#!/bin/bash
# test-tool-blocks-collapsed-default.sh
# Tests: toolBlocksCollapsed initializes to true (matching DOM's hidden tool bodies)

# Global variable declaration should be true (not false)
grep -q 'let toolBlocksCollapsed = true' /opt/feather-dev/static/index.html || exit 1

# Session load should reset to true, not false
grep -q 'toolBlocksCollapsed = true' /opt/feather-dev/static/index.html || exit 1

exit 0
