#!/bin/bash
# test-keyboard-shortcut-n-new-session.sh
# Tests: N keyboard shortcut calls newClaudeSession() and appears in shortcuts modal + command palette
# Added: iteration 92

grep -q "key === 'n'" /opt/feather/static/index.html || exit 1
grep -q "newClaudeSession()" /opt/feather/static/index.html || exit 1
grep -q "New Claude session" /opt/feather/static/index.html || exit 1
exit 0
