#!/bin/bash
# test-search-preserves-relevance-order.sh
# Tests: pinned/starred sessions are NOT sorted to top in search mode (preserves API relevance order)

# The fix: skip pinned/starred sorting when searchApiResults !== null
python3 -c "
import re
content = open('/opt/feather-dev/static/index.html').read()
# Check that the pinned/starred sort block is guarded by searchApiResults === null
if re.search(r'if\s*\(searchApiResults\s*===\s*null\)\s*\{[^}]*pinnedSessions', content, re.DOTALL):
    print('PASS: pinned/starred sort guarded by searchApiResults === null')
    exit(0)
print('FAIL: pinned/starred sort not guarded against search mode')
exit(1)
"
