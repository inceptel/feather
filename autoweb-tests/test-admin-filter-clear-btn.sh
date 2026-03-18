#!/bin/bash
# test-admin-filter-clear-btn.sh
# Tests: admin service filter has a clear (×) button that calls clearServiceFilter

grep -q 'id="filter-clear-btn"' /opt/feather-dev/static/admin/index.html || exit 1
grep -q 'clearServiceFilter' /opt/feather-dev/static/admin/index.html || exit 1
exit 0
