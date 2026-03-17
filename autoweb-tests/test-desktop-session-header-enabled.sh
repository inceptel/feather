#!/bin/bash
# test-desktop-session-header-enabled.sh
# Tests: desktop-session-header does not have md:hidden in initial class (was permanently hidden due to bug)
# Added: iteration 80

# The desktop header should not be permanently hidden by md:hidden
if grep 'id="desktop-session-header"' /opt/feather/static/index.html | grep -q 'md:hidden'; then
    echo "FAIL: desktop-session-header still has md:hidden class (permanently hidden)"
    exit 1
fi
echo "PASS: desktop-session-header no longer has md:hidden"
exit 0
