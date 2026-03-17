#!/bin/bash
# test-context-menu-copy-link.sh
# Tests: Session context menu has "Copy link" option with ctxCopyLink function
# Added: iteration 92+

# Check that ctxCopyLink function exists
grep -q 'function ctxCopyLink' /opt/feather/static/index.html || exit 1

# Check that Copy link menu item is in the context menu
grep -q 'ctxCopyLink\(\)' /opt/feather/static/index.html || exit 1

exit 0
