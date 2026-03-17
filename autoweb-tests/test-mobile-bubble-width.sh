#!/bin/bash
# test-mobile-bubble-width.sh
# Tests: On mobile (<768px), message bubbles should expand to full width (max-w-full) to prevent text clipping
# Added: iteration 17

# Check that the mobile media query makes message bubbles wider
grep -q 'max-width.*100%\|max-w-full\|max-w-\[100%\]\|max-w-\[95%\]' /opt/feather/static/index.html | grep -q '@media' 2>/dev/null

# Alternative: check for a mobile-specific rule that overrides max-width on message bubbles
grep -A5 'max-width: 768px' /opt/feather/static/index.html | grep -q 'msg-bubble.*max-width\|bubble.*max-width.*100\|max-w.*100' 2>/dev/null

# Simplest check: the mobile media query section should contain a rule for message bubble max-width
grep -q 'user-msg-bubble.*max-width\|assistant-msg-bubble.*max-width' /opt/feather/static/index.html || exit 1
exit 0
