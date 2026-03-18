#!/bin/bash
# Test: build list entries show absolute date as tooltip on hover
FILE="/opt/feather/static/admin/index.html"

# Check that absDate is computed from mtime using toLocaleString
grep -q "toLocaleString" "$FILE" || { echo "FAIL: toLocaleString not used for absolute date"; exit 1; }

# Check that absDate is used as title attribute on the time span
grep -q 'title="${esc(absDate)}"' "$FILE" || { echo "FAIL: absDate tooltip not applied to time span"; exit 1; }

# Check the span has cursor-default so it's clear it's hoverable
grep -q 'cursor-default.*title.*absDate\|title.*absDate.*cursor-default' "$FILE" || grep -q 'cursor-default" title="${esc(absDate)}"' "$FILE" || { echo "FAIL: cursor-default missing on time span with tooltip"; exit 1; }

echo "PASS: admin build entries show absolute date tooltip"
exit 0
