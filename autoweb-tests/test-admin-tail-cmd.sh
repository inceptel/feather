#!/bin/bash
# Test: Admin service cards have a tail log button (≡) that copies supervisorctl tail -f command
FILE="/opt/feather/static/admin/index.html"

# Check copyTailCmd function exists
if ! grep -q "function copyTailCmd" "$FILE"; then
    echo "FAIL: copyTailCmd function not found"
    exit 1
fi

# Check supervisorctl tail -f command is used
if ! grep -q "supervisorctl tail -f" "$FILE"; then
    echo "FAIL: supervisorctl tail -f not found"
    exit 1
fi

# Check ≡ button is rendered in service cards
if ! grep -q "copyTailCmd(this" "$FILE"; then
    echo "FAIL: copyTailCmd button not in service card HTML"
    exit 1
fi

# Check shortcuts panel mentions tail
if ! grep -q "tail log\|≡ tail" "$FILE"; then
    echo "FAIL: shortcuts panel does not mention tail log"
    exit 1
fi

echo "PASS: Admin tail log button present"
