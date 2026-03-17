#!/bin/bash
# test-mobile-nav-pills-compact.sh
# Tests: Mobile nav pills have compact sizing (11px font, 32px min-width, 40px min-height)
# Added: iteration 23

# Check that mobile media query has compact nav pill styles
grep -q 'font-size: 11px' /opt/feather/static/index.html || exit 1
grep -q 'min-width: 32px' /opt/feather/static/index.html || exit 1
grep -q 'min-height: 40px' /opt/feather/static/index.html || exit 1
grep -q 'padding-right: 28px' /opt/feather/static/index.html || exit 1
exit 0
