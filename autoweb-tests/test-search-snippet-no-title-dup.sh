#!/bin/bash
# test-search-snippet-no-title-dup.sh
# Tests: title-only search snippets are suppressed (only content snippets shown)

grep -q "s\._snippet && s\._snippet\.startsWith('\.\.\.')" /opt/feather-dev/static/index.html || exit 1
exit 0
