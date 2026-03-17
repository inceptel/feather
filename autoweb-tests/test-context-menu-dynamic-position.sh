#!/bin/bash
# test-context-menu-dynamic-position.sh
# Tests: context menu uses dynamic menu height (offsetHeight) for positioning, not hardcoded 160

grep -q 'menu.offsetHeight' /opt/feather-dev/static/index.html || exit 1
exit 0
