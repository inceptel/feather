#!/bin/bash
# test-search-min-chars-hint.sh
# Tests: filterSessions shows "Type N more character(s) to search" hint for 1-2 char queries

grep -q 'Type.*more character' /opt/feather-dev/static/index.html || exit 1
grep -q '3 - query.length' /opt/feather-dev/static/index.html || exit 1
exit 0
