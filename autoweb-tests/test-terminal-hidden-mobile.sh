#!/bin/bash
# test-terminal-hidden-mobile.sh
# Tests: terminal toggle button is hidden on mobile via CSS

grep -q '#terminal-toggle' /opt/feather/static/index.html || exit 1
grep -q '#tools-toggle-btn.*#terminal-toggle\|#terminal-toggle.*display: none' /opt/feather/static/index.html || exit 1
exit 0
