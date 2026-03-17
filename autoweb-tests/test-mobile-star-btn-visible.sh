#!/bin/bash
# test-mobile-star-btn-visible.sh
# Tests: Mobile star button in session list is always visible (not opacity-0 on touch)

grep -q 'session-item .star-btn.*opacity.*0\.35' /opt/feather/static/index.html || exit 1
exit 0
