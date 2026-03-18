#!/bin/bash
# Test: chat search case-sensitivity persists in localStorage
set -e
INDEX=/opt/feather/static/index.html

# Should initialize from localStorage
grep -q "localStorage.getItem('feather-chat-search-case') === 'true'" "$INDEX" || { echo "FAIL: case init from localStorage missing"; exit 1; }

# Should save to localStorage on toggle
grep -q "localStorage.setItem('feather-chat-search-case'" "$INDEX" || { echo "FAIL: localStorage.setItem for case missing"; exit 1; }

# closeChatSearch should NOT reset _chatSearchCaseSensitive
# (verify the old reset line is gone)
python3 - <<'PY'
import re, sys
txt = open('/opt/feather/static/index.html').read()
# Find closeChatSearch function body
m = re.search(r'function closeChatSearch\(\)\s*\{(.*?)\n\s*\}', txt, re.DOTALL)
if not m:
    print("FAIL: closeChatSearch not found"); sys.exit(1)
body = m.group(1)
if '_chatSearchCaseSensitive = false' in body:
    print("FAIL: closeChatSearch still resets _chatSearchCaseSensitive"); sys.exit(1)
print("PASS")
PY
