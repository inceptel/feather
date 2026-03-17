#!/bin/bash
# test-no-duplicate-hide-session.sh
# Tests: command palette does not have duplicate 'Hide current session' entries

count=$(grep -c "label: 'Hide current session'" /opt/feather/static/index.html)
[ "$count" -eq 1 ] || { echo "Expected 1 'Hide current session' entry, got $count"; exit 1; }
exit 0
