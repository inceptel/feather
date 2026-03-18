#!/bin/bash
# Test: W keyboard shortcut opens current session in new tab
FILE="/opt/feather/static/index.html"

# Check openCurrentSessionNewTab function exists
grep -q "function openCurrentSessionNewTab" "$FILE" || { echo "FAIL: openCurrentSessionNewTab function missing"; exit 1; }

# Check W key handler exists in keydown listener
grep -q "e.key === 'w' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey" "$FILE" || { echo "FAIL: W key handler missing"; exit 1; }

# Check openCurrentSessionNewTab uses window.open with _blank
grep -q "window.open.*_blank" "$FILE" || { echo "FAIL: window.open _blank missing in new-tab function"; exit 1; }

# Check command palette entry
grep -q "Open session in new tab.*shortcut.*W" "$FILE" || { echo "FAIL: command palette entry missing"; exit 1; }

# Check shortcuts modal entry
grep -q "Open session in new tab" "$FILE" || { echo "FAIL: shortcuts modal entry missing"; exit 1; }

echo "PASS"
exit 0
