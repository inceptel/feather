#!/bin/bash
# test-interrupt-btn-mobile-icon.sh
# Tests: Interrupt button shows icon on mobile (sm:hidden svg) and text on desktop (hidden sm:inline span)
# Added: iteration 27

# Check that the interrupt button contains an SVG with sm:hidden (mobile icon)
grep -q 'id="ctrlc-btn".*sm:hidden' /opt/feather/static/index.html || exit 1

# Check that the interrupt button contains a span with hidden sm:inline (desktop text)
grep -q 'id="ctrlc-btn".*hidden sm:inline.*Interrupt' /opt/feather/static/index.html || exit 1

exit 0
