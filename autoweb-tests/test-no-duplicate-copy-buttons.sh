#!/bin/bash
# test-no-duplicate-copy-buttons.sh
# Tests: addCopyButton guards against adding duplicate copy buttons to the same pre element
# Added: iteration 12

# The addCopyButton function must check if a .code-copy-btn already exists before adding one
# This prevents duplicate buttons during streaming updates (updateAssistantMessage calls addCopyButton repeatedly)
grep -A5 'function addCopyButton' /opt/feather/static/index.html | grep -q 'code-copy-btn' || exit 1
# The guard should return early if button exists
grep -A3 'function addCopyButton' /opt/feather/static/index.html | grep -q 'return' || exit 1
exit 0
