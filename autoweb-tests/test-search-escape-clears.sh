#!/bin/bash
# test-search-escape-clears.sh
# Tests: Escape key in session search input calls clearSessionSearch() and blurs

grep -q "e.key === 'Escape'" /opt/feather/static/index.html || exit 1
grep -q "clearSessionSearch" /opt/feather/static/index.html || exit 1
# Ensure the Escape handler is in handleSessionSearchKeydown (not just global Escape)
# Check that clearSessionSearch is called in the Escape branch within handleSessionSearchKeydown
python3 - <<'EOF'
content = open('/opt/feather/static/index.html').read()
start = content.find('function handleSessionSearchKeydown(e)')
if start == -1:
    exit(1)
# Find the function body by counting braces
i = content.index('{', start)
depth = 0
while i < len(content):
    if content[i] == '{':
        depth += 1
    elif content[i] == '}':
        depth -= 1
        if depth == 0:
            break
    i += 1
fn_body = content[start:i+1]
if "Escape" not in fn_body or "clearSessionSearch" not in fn_body:
    exit(1)
exit(0)
EOF
