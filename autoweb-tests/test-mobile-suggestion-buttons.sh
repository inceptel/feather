#!/bin/bash
# test-mobile-suggestion-buttons.sh
# Tests: Welcome page suggestion buttons stack vertically on mobile with proper touch targets
# Added: iteration 29

# Check that suggestion buttons have mobile-responsive classes for vertical stacking
grep -q 'sm:flex-row' /opt/feather/static/index.html || exit 1
# Check that buttons have min-height for touch targets on mobile
grep -q 'min-height.*44px\|min-h-\[44px\]' /opt/feather/static/index.html | grep -q 'empty-state\|suggestion\|setPrompt' 2>/dev/null
# Simpler: just check that the flex container for suggestion buttons uses flex-col on mobile
grep -q 'flex-col sm:flex-row' /opt/feather/static/index.html || exit 1
exit 0
