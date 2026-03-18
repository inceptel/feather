#!/bin/bash
# test-thinking-collapsed-persist.sh
# Tests: thinkingBlocksCollapsed preference is persisted to localStorage

INDEX=/opt/feather/static/index.html

# localStorage key is used for initialization
grep -q "feather-thinking-collapsed" "$INDEX" || { echo "FAIL: feather-thinking-collapsed localStorage key not found"; exit 1; }

# toggleAllThinking saves to localStorage
grep -A15 "function toggleAllThinking" "$INDEX" | grep -q "localStorage.setItem.*feather-thinking-collapsed" || { echo "FAIL: thinking collapsed state not saved to localStorage on toggle"; exit 1; }

# Initial value reads from localStorage with fallback to mobile default
grep -A2 "let thinkingBlocksCollapsed" "$INDEX" | grep -q "localStorage.getItem.*feather-thinking-collapsed" || { echo "FAIL: thinkingBlocksCollapsed does not read from localStorage on init"; exit 1; }

echo "PASS"
exit 0
