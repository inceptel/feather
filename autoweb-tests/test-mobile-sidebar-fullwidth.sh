#!/bin/bash
# test-mobile-sidebar-fullwidth.sh
# Tests: Sidebar takes full width on mobile (100vw) instead of partial width
# Added: iteration 16

grep -q 'width: 100vw; max-width: 100vw' /opt/feather/static/index.html || exit 1
exit 0
