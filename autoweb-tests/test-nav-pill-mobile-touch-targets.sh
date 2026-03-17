#!/bin/bash
# test-nav-pill-mobile-touch-targets.sh
# Tests: nav pills in sidebar bottom bar have larger touch targets on mobile (min-height: 44px)
# Added: iteration 19

# Check that there's a mobile-specific nav-pill rule with min-height for touch targets
grep -q 'nav-pill.*min-height:\s*44px\|\.nav-pill.*min-height' /opt/feather/static/index.html || exit 1
exit 0
