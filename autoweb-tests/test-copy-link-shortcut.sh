#!/bin/bash
# Test: C keyboard shortcut copies session link
FILE=/opt/feather/static/index.html

# Check the 'c' key shortcut handler exists
if ! grep -q "e.key === 'c'" "$FILE"; then
    echo "FAIL: 'c' key handler not found"
    exit 1
fi

# Check it calls copyCurrentSessionLink
if ! grep -q "copyCurrentSessionLink" "$FILE"; then
    echo "FAIL: copyCurrentSessionLink call not found near 'c' key handler"
    exit 1
fi

# Check C is in command palette items
if ! grep -q "'Copy session link'.*shortcut.*'C'" "$FILE"; then
    echo "FAIL: 'Copy session link' with shortcut 'C' not found in command palette"
    exit 1
fi

# Check C is in shortcuts modal
if ! grep -q "Copy session link" "$FILE"; then
    echo "FAIL: 'Copy session link' not found in shortcuts modal"
    exit 1
fi

echo "PASS: C shortcut copies session link, listed in palette and shortcuts modal"
