#!/bin/bash
# test-hide-session-shortcut.sh
# Tests: D keyboard shortcut exists for hiding the current session
# Added: iteration 86

# Check that the keydown handler includes 'd' for hideSession
grep -q "key === 'd'" /opt/feather/static/index.html || exit 1

# Check that hideSession is called for 'd' key
grep -A5 "key === 'd'" /opt/feather/static/index.html | grep -q "hideSession\|hide" || exit 1

# Check shortcuts modal lists D shortcut
grep -q "Hide session" /opt/feather/static/index.html || exit 1

exit 0
