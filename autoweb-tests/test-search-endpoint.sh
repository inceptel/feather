#!/bin/bash
# test-search-endpoint.sh
# Tests: /api/search?q=... endpoint exists and returns JSON with results/query/total fields

RESULT=$(curl -s "http://localhost:4860/api/search?q=test")
echo "$RESULT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert 'query' in data, 'missing query field'
assert 'results' in data, 'missing results field'
assert 'total' in data, 'missing total field'
assert isinstance(data['results'], list), 'results should be list'
if data['results']:
    r = data['results'][0]
    assert 'session_id' in r, 'missing session_id'
    assert 'title' in r, 'missing title'
    assert 'score' in r, 'missing score'
    assert 'snippet' in r, 'missing snippet'
print('PASS')
" || exit 1

# Test empty query returns empty results
EMPTY=$(curl -s "http://localhost:4860/api/search?q=")
echo "$EMPTY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
assert data['total'] == 0, 'empty query should return 0 results'
print('PASS empty')
" || exit 1

exit 0
