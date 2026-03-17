#!/bin/bash
# test-desktop-session-header-star-btn.sh
# Tests: desktop session header has a star button with id=desktop-star-btn
# Added: iter 82

grep -q 'id="desktop-star-btn"' /opt/feather/static/index.html || exit 1
exit 0
