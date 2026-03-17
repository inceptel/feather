#!/bin/bash
# test-desktop-header-copy-link.sh
# Tests: desktop session header has a copy-link button (id=desktop-copy-link-btn)
# Added: iteration 84

grep -q 'id="desktop-copy-link-btn"' /opt/feather/static/index.html || exit 1
grep -q 'copyCurrentSessionLink' /opt/feather/static/index.html || exit 1
exit 0
