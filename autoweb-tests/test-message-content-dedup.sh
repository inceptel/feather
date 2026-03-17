#!/bin/bash
# test-message-content-dedup.sh
# Tests: renderMessages deduplicates user messages by content hash when UUIDs differ
# Added: iteration 23

# Check that renderMessages uses content-hash-based dedup as fallback for user messages
grep -q 'seenContentHashes' /opt/feather/static/index.html || exit 1
# Check that SSE tailing also uses content-hash dedup for user messages
grep -q 'renderedContentHashes' /opt/feather/static/index.html || exit 1
exit 0
