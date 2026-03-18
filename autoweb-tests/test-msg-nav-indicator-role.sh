#!/bin/bash
# Test: message navigation indicator shows role (you/claude) alongside position
set -e
FILE=/opt/feather/static/index.html

# Check showMsgNavIndicator accepts a role parameter
grep -q "function showMsgNavIndicator(idx, total, role)" "$FILE" || { echo "FAIL: showMsgNavIndicator missing role parameter"; exit 1; }

# Check role is appended to the textContent
grep -A5 "function showMsgNavIndicator" "$FILE" | grep -q "role ? '.*' + role" || { echo "FAIL: role not appended in showMsgNavIndicator"; exit 1; }

# Check navigateMessages detects role and passes it
grep -A25 "function navigateMessages" "$FILE" | grep -q "querySelector.*user-msg-bubble.*you" || { echo "FAIL: navigateMessages not detecting role"; exit 1; }

# Check jumpToMessage also passes role
grep -A20 "function jumpToMessage" "$FILE" | grep -q "querySelector.*user-msg-bubble.*you" || { echo "FAIL: jumpToMessage not detecting role"; exit 1; }

echo "PASS: message navigation indicator shows role (you/claude) correctly"
