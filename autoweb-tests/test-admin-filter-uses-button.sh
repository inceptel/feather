#!/bin/bash
# test-admin-filter-uses-button.sh
# Tests: filterServices queries button.font-medium (service names are <button>, not <span>)

grep -q "button.font-medium" /opt/feather-dev/static/admin/index.html || exit 1
exit 0
