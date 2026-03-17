#!/bin/bash
# test-no-duplicate-image-filename.sh
# Tests: Image attachments in addUserMessageWithImage should NOT show a redundant filename link below the preview
# Added: iteration 8

# The addUserMessageWithImage function should render the image preview only,
# not both the preview AND a filename text link below it.
# Check that within the function body there is no filename label div.
count=$(grep -A20 'function addUserMessageWithImage' /opt/feather/static/index.html | grep -c 'text-xs text-smoke-7')
if [ "$count" -gt 0 ]; then
    echo "FAIL: addUserMessageWithImage still has redundant filename link"
    exit 1
fi
exit 0
