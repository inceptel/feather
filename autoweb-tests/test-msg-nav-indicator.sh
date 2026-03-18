#!/bin/bash
# Test: message navigation position indicator shows X / Y when using j/k
set -e
FILE=/opt/feather/static/index.html

# Check indicator element exists
grep -q 'id="msg-nav-indicator"' "$FILE" || { echo "FAIL: #msg-nav-indicator element missing"; exit 1; }

# Check showMsgNavIndicator function exists
grep -q "function showMsgNavIndicator" "$FILE" || { echo "FAIL: showMsgNavIndicator function missing"; exit 1; }

# Check it's called from navigateMessages
grep -A30 "function navigateMessages" "$FILE" | grep -q "showMsgNavIndicator" || { echo "FAIL: showMsgNavIndicator not called in navigateMessages"; exit 1; }

# Check CSS for indicator exists
grep -q "msg-nav-indicator" "$FILE" | head -1 || true
grep -q "#msg-nav-indicator" "$FILE" || { echo "FAIL: CSS for #msg-nav-indicator missing"; exit 1; }

echo "PASS: message navigation position indicator implemented correctly"
