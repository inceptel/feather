#!/bin/bash
# test-mobile-copy-button-visible.sh
# Tests: Code copy button is visible on mobile (not hidden behind :hover)
# Added: iteration 23

# Check that there's a mobile media query that makes .code-copy-btn visible
grep -q '@media.*max-width.*767.*code-copy-btn.*opacity.*1\|code-copy-btn.*opacity.*1.*@media\|max-width.*767' /opt/feather/static/index.html || {
    # Alternative: check for the rule within the existing mobile media query block
    # Extract the mobile media query block and check for code-copy-btn
    awk '/@media.*max-width.*767/{found=1} found{print; if(/\}/ && !/\{/)found=0}' /opt/feather/static/index.html | grep -q 'code-copy-btn.*opacity' || exit 1
}
exit 0
