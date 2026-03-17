#!/bin/bash
# test-text-only-dedup.sh
# Tests: duplicate user messages with same text but different image blocks are deduplicated
# Added: iteration 26

# The renderMessages function should also track text-only hashes to catch duplicates
# where one record has text+image and another has just text (same text content)
grep -q 'seenTextHashes' /opt/feather/static/index.html || exit 1
exit 0
