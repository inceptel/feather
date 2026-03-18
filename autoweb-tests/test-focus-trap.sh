#!/bin/bash
# Test focus trap in command palette
INDEX="/opt/feather/static/index.html"

# Check trapFocusHandler utility exists
grep -q 'function trapFocusHandler' "$INDEX" || { echo "FAIL: trapFocusHandler function not found"; exit 1; }

# Check focus trap checks for Tab key
grep -A5 'function trapFocusHandler' "$INDEX" | grep -q "e.key !== 'Tab'" || { echo "FAIL: focus trap does not check for Tab key"; exit 1; }

# Check focus trap handles Shift+Tab (reverse direction)
grep -A15 'function trapFocusHandler' "$INDEX" | grep -q 'e.shiftKey' || { echo "FAIL: focus trap does not handle Shift+Tab"; exit 1; }

# Check command palette installs focus trap on open
grep -A15 'function openCommandPalette' "$INDEX" | grep -q 'trapFocusHandler' || { echo "FAIL: openCommandPalette does not install focus trap"; exit 1; }

# Check focus trap is removed on close
grep -A10 'function closeCommandPalette' "$INDEX" | grep -q 'removeEventListener' || { echo "FAIL: closeCommandPalette does not remove focus trap"; exit 1; }

echo "PASS: focus trap is properly implemented in command palette"
