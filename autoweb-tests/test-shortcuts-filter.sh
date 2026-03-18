#!/bin/bash
# Test shortcuts modal search/filter input
INDEX="/opt/feather/static/index.html"

# Check search input exists in shortcuts modal
grep -q 'id="shortcuts-search"' "$INDEX" || { echo "FAIL: shortcuts-search input not found"; exit 1; }

# Check list container has id
grep -q 'id="shortcuts-list"' "$INDEX" || { echo "FAIL: shortcuts-list container not found"; exit 1; }

# Check filterShortcuts function exists
grep -q 'function filterShortcuts' "$INDEX" || { echo "FAIL: filterShortcuts function not found"; exit 1; }

# Check openShortcutsModal resets and focuses the search input
grep -A5 'function openShortcutsModal' "$INDEX" | grep -q 'shortcuts-search' || { echo "FAIL: openShortcutsModal does not reference shortcuts-search"; exit 1; }

echo "PASS: shortcuts modal search/filter is properly implemented"
