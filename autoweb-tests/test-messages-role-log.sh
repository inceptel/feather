#!/bin/bash
# Test: messages container has role="log" for screen reader accessibility

FILE="/opt/feather/static/index.html"

if grep -q 'id="messages".*role="log"' "$FILE" || grep -q 'role="log".*id="messages"' "$FILE"; then
    echo "PASS: messages container has role=log"
    exit 0
else
    echo "FAIL: messages container missing role=log"
    exit 1
fi
