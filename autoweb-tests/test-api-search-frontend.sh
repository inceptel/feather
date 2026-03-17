#!/bin/bash
# test-api-search-frontend.sh
# Tests: frontend filterSessions uses server-side /api/search for queries >= 3 chars

grep -q 'performApiSearch' /opt/feather/static/index.html || exit 1
grep -q 'searchApiResults' /opt/feather/static/index.html || exit 1
grep -q "query.length >= 3" /opt/feather/static/index.html || exit 1
grep -q '/api/search?q=' /opt/feather/static/index.html || exit 1
grep -q '_snippet' /opt/feather/static/index.html || exit 1
exit 0
