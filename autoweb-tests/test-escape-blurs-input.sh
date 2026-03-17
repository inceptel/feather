#!/bin/bash
# test-escape-blurs-input.sh
# Tests: Pressing Escape in chat input should blur it (call input.blur())
# Added: iteration 13

# Check that the Escape handler in handleKeydown includes input.blur()
grep -A8 "key === 'Escape'" /opt/feather/static/index.html | grep -q 'input.blur()' || exit 1
exit 0
