#!/bin/bash
# test-search-snippet-content.sh
# Tests: /api/search snippets prefer message content over title text

result=$(curl -s "http://localhost:4860/api/search?q=test" | python3 -c "
import json, sys
r = json.load(sys.stdin)
# Find a result where title contains 'test' - the snippet should NOT just be the title
for res in r['results']:
    title = res.get('title', '')
    snippet = res.get('snippet', '')
    if 'test' in title.lower() and snippet == title:
        print('FAIL: snippet is same as title for: ' + title[:50])
        sys.exit(1)
print('OK')
")

[ "$result" = "OK" ] || { echo "$result"; exit 1; }
exit 0
