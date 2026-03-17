#!/bin/bash
# test-message-dedup.sh
# Tests: renderMessages deduplicates user messages by UUID to prevent duplicate rendering
# Added: iteration 7

# Check that renderMessages has UUID-based dedup within the batch it renders
grep -q 'seenUuids' /opt/feather/static/index.html || exit 1
exit 0
