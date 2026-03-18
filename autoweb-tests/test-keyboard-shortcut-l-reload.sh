#!/bin/bash
# test-keyboard-shortcut-l-reload.sh
# Tests: L keyboard shortcut reloads session list

# Check keydown handler for 'l'
grep -q "key === 'l'" /opt/feather/static/index.html || exit 1
# Check it calls loadSessions
grep -q "loadSessions();" /opt/feather/static/index.html || exit 1
# Check shortcuts modal documents L
grep -q "Reload session list" /opt/feather/static/index.html || exit 1
# Check command palette has it too
grep -q "'Reload session list'" /opt/feather/static/index.html || exit 1
exit 0
