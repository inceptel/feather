#!/bin/bash
# test-command-palette-session-meta.sh
# Tests: command palette session items include time+message-count metadata
# Added: iteration 101

# Check that session items in getFilteredCommands include formatTime and message_count meta
grep -q "formatTime(s.lastUpdated)" /opt/feather/static/index.html || exit 1
grep -q "s.message_count.*msg" /opt/feather/static/index.html || exit 1

exit 0
