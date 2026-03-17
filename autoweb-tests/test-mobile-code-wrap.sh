#!/bin/bash
# test-mobile-code-wrap.sh
# Tests: Mobile media query makes code blocks wrap instead of horizontal scroll

grep -q 'pre-wrap.*word-wrap.*break-word\|word-wrap.*break-word.*pre-wrap' /opt/feather/static/index.html || exit 1
grep -q 'overflow-x: hidden' /opt/feather/static/index.html || exit 1
exit 0
