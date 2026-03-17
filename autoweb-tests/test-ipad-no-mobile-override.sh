#!/bin/bash
# test-ipad-no-mobile-override.sh
# Tests: The mobile CSS media query uses max-width: 767px (not 768px) so it doesn't
# overlap with Tailwind's md: breakpoint (min-width: 768px). At 768px (iPad Mini),
# the sidebar should NOT get full-width mobile styling.
# Added: iteration 19

# The media query should use 767px, not 768px
grep -q '@media (max-width: 767px)' /opt/feather/static/index.html || exit 1
# There should NOT be a 768px max-width media query
grep -q '@media (max-width: 768px)' /opt/feather/static/index.html && exit 1
exit 0
