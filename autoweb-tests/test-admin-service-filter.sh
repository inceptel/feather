#!/bin/bash
# test-admin-service-filter.sh
# Tests: admin page has a service filter input above services list

grep -q 'id="service-filter"' /opt/feather-dev/static/admin/index.html || exit 1
grep -q 'filterServices' /opt/feather-dev/static/admin/index.html || exit 1
exit 0
