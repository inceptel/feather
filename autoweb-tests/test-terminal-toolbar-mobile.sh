#!/bin/bash
# test-terminal-toolbar-mobile.sh
# Tests: Terminal toolbar signal buttons (Esc, ^C, ^D) are hidden on mobile via CSS
# Added: iteration 17

# Check that terminal-signals container exists with hidden md:flex classes
grep -q 'terminal-signals hidden md:flex' /opt/feather/static/index.html || exit 1
# Check that terminal-session is hidden on mobile
grep -q 'terminal-session.*hidden md:inline' /opt/feather/static/index.html || exit 1
exit 0
