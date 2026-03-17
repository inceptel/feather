#!/bin/bash
# test-singular-line-grammar.sh
# Tests: tool result summary uses "1 line" (singular) not "1 lines"
# Added: iteration 34

grep -q "lineCount === 1 ? 'line' : 'lines'" /opt/feather/static/index.html || exit 1
exit 0
