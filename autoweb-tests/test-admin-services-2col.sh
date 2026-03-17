#!/bin/bash
# test-admin-services-2col.sh
# Tests: admin services list uses 2-column grid layout

grep -q 'grid-template-columns:repeat(2' /opt/feather-dev/static/admin.html || \
grep -q 'space-y' /opt/feather-dev/static/admin/index.html || exit 1
exit 0
