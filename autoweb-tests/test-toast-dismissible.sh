#!/bin/bash
# test-toast-dismissible.sh
# Tests: showToast adds click listener for dismissal (toast.onclick or addEventListener click)
# Added: iteration 95

# Check that showToast function itself sets up click dismiss
grep -A 20 'function showToast' /opt/feather/static/index.html | grep -q 'onclick\|addEventListener.*click' || exit 1

exit 0
