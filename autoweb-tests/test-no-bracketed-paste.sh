#!/bin/bash
# test-no-bracketed-paste.sh
# Tests: Long messages sent via WebSocket do NOT use bracketed paste mode escape sequences
# Added: iteration after learning Claude CLI doesn't support bracketed paste

# The fix removes \x1b[200~ and \x1b[201~ from the WebSocket send path
# Check that the code does NOT use bracketed paste wrapping
if grep -q "\\\\x1b\[200~.*sendMessage.*\\\\x1b\[201~" /opt/feather/static/index.html; then
    echo "FAIL: Still using bracketed paste mode"
    exit 1
fi

# Also verify WS send path still sends the message (not empty)
grep -q "wsToUse.send(sendMessage" /opt/feather/static/index.html || \
grep -q "wsToUse\.send(sendMessage" /opt/feather/static/index.html || \
grep -q "wsToUse\.send(msg" /opt/feather/static/index.html || \
grep -q "wsToUse\.send(text" /opt/feather/static/index.html || exit 1

echo "PASS: No bracketed paste in WS send path"
exit 0
