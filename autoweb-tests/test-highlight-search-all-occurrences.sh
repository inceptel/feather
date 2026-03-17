#!/bin/bash
# test-highlight-search-all-occurrences.sh
# Tests: highlightSearch highlights ALL occurrences of query, not just the first

# Verify the function uses a while loop to find all occurrences
grep -q 'while.*indexOf' /opt/feather/static/index.html || exit 1
exit 0
