#!/bin/bash
# test-admin-filter-keyboard.sh
# Tests: admin service filter can be focused with "/" and cleared with Escape

grep -q "key === '/'" /opt/feather-dev/static/admin/index.html || exit 1
grep -q "key === 'Escape'" /opt/feather-dev/static/admin/index.html || exit 1
grep -q "service-filter" /opt/feather-dev/static/admin/index.html || exit 1
exit 0
