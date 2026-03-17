#!/bin/bash
# test-blockquote-styling.sh
# Tests: blockquote, link, and hr styling in markdown content
# Added: iteration 14

# Check that blockquote styling exists in markdown-content
grep -q 'markdown-content blockquote' /opt/feather/static/index.html || exit 1
# Check that link styling exists in markdown-content
grep -q 'markdown-content a' /opt/feather/static/index.html || exit 1
# Check that hr styling exists in markdown-content
grep -q 'markdown-content hr' /opt/feather/static/index.html || exit 1
exit 0
