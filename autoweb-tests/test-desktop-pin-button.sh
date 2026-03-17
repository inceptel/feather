#!/bin/bash
# test-desktop-pin-button.sh
# Tests: desktop session header has a pin button with id=desktop-pin-btn

grep -q 'id="desktop-pin-btn"' /opt/feather-dev/static/index.html || exit 1
grep -q 'togglePinSession(currentSessionId)' /opt/feather-dev/static/index.html || exit 1
exit 0
