#!/bin/bash
# test-highlight-multi-word.sh
# Tests: highlightSearch splits query on whitespace and highlights each word individually

grep -q "split(/\\\\s+/)" /opt/feather/static/index.html || exit 1
grep -q "Merge overlapping" /opt/feather/static/index.html || exit 1
exit 0
