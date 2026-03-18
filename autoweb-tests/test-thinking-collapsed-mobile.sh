#!/bin/bash
# test-thinking-collapsed-mobile.sh
# Tests: thinkingBlocksCollapsed defaults to mobile-aware value (window.innerWidth < 768)

# thinkingBlocksCollapsed should have window.innerWidth < 768 as mobile fallback
# The value may appear in a ternary or direct assignment — just check the mobile default is present near init
grep -A5 'let thinkingBlocksCollapsed' /opt/feather-dev/static/index.html | grep -q 'window.innerWidth < 768' || exit 1
exit 0
