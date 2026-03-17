#!/bin/bash
# test-message-overflow.sh
# Tests: message-container and messages div have proper overflow containment
# Added: iteration 12

# message-container must have min-w-0 and w-full to prevent flex overflow
grep -q 'id="message-container"' /opt/feather/static/index.html || exit 1
grep 'id="message-container"' /opt/feather/static/index.html | grep -q 'min-w-0' || exit 1

# messages div should have overflow-x-hidden to clip any remaining overflow
grep 'id="messages"' /opt/feather/static/index.html | grep -q 'overflow-x-hidden' || exit 1

# tool-header should have min-w-0 or overflow-hidden to contain long text
grep 'tool-header' /opt/feather/static/index.html | grep -q 'min-w-0' || exit 1

exit 0
