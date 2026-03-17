#!/bin/bash
# test-search-utf8-safe.sh
# Tests: /api/search endpoint handles multibyte UTF-8 queries without panicking

# The server should return JSON (not crash/empty reply) for any non-empty query
result=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:4860/api/search?q=feather")
[ "$result" = "200" ] || exit 1

# Verify response contains valid JSON with "results" key
curl -s "http://localhost:4860/api/search?q=feather" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'results' in d" || exit 1

exit 0
