#!/bin/bash
# test-thinking-collapsed-mobile.sh
# Tests: thinkingBlocksCollapsed defaults to mobile-aware value (window.innerWidth < 768)

grep -q 'thinkingBlocksCollapsed = window.innerWidth < 768' /opt/feather-dev/static/index.html || exit 1
exit 0
