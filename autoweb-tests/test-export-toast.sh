#!/bin/bash
# test-export-toast.sh
# Tests: exportSessionMarkdown shows toast on success and error
# Added: iteration 90

# Check that exportSessionMarkdown calls showToast with success message
grep -q "showToast.*xport" /opt/feather/static/index.html || exit 1
# Check that exportSessionMarkdown calls showToast on error
grep -A 5 "catch.*e.*{" /opt/feather/static/index.html | grep -q "showToast\|toast" || exit 1
exit 0
