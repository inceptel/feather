#!/bin/bash
# test-tool-blocks-collapsed-persist.sh
# Tests: toolBlocksCollapsed state persists to localStorage across page reloads

FILE=/opt/feather/static/index.html

# Check initialization reads from localStorage
grep -q "localStorage.getItem('feather-tool-blocks-collapsed')" "$FILE" || { echo "FAIL: toolBlocksCollapsed not read from localStorage"; exit 1; }

# Check localStorage is saved on toggle
grep -A3 "function toggleAllTools" "$FILE" | grep -q "localStorage.setItem('feather-tool-blocks-collapsed'" || { echo "FAIL: toolBlocksCollapsed not saved to localStorage on toggle"; exit 1; }

# Check fallback default is true (collapsed by default)
grep -A3 "localStorage.getItem('feather-tool-blocks-collapsed') !== null" "$FILE" | grep -q ": true" || { echo "FAIL: toolBlocksCollapsed fallback default is not true"; exit 1; }

echo "PASS: tool blocks collapsed state persists to localStorage"
