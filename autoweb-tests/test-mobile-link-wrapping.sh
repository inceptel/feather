#!/bin/bash
# test-mobile-link-wrapping.sh
# Tests: markdown links have word-break for mobile overflow prevention
# Added: iteration 33

grep -q 'markdown-content a.*word-break.*break-all' /opt/feather/static/index.html || exit 1
exit 0
