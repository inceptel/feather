#!/bin/bash
# test-admin-services-grid.sh
# Tests: services-list uses 2-column CSS grid

grep -q 'id="services-list" class="grid grid-cols-2' /opt/feather-dev/static/admin/index.html || exit 1
exit 0
