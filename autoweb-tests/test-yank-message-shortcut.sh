#!/bin/bash
# Test: Y keyboard shortcut and yankFocusedMessage function exist
set -e
FILE=/opt/feather/static/index.html

# Check yankFocusedMessage function exists
grep -q "function yankFocusedMessage" "$FILE" || { echo "FAIL: yankFocusedMessage function missing"; exit 1; }

# Check Y keydown handler exists
grep -q "e.key === 'y'" "$FILE" || { echo "FAIL: y key handler missing"; exit 1; }

# Check yankFocusedMessage is called in Y handler
grep -A5 "e.key === 'y'" "$FILE" | grep -q "yankFocusedMessage" || { echo "FAIL: yankFocusedMessage not called in y handler"; exit 1; }

# Check Y shortcut in shortcuts modal
grep -q "Yank.*focused message" "$FILE" || { echo "FAIL: Y shortcut not in shortcuts modal"; exit 1; }

# Check Y in command palette
grep -q "Yank (copy) focused message" "$FILE" || { echo "FAIL: Y not in command palette"; exit 1; }

echo "PASS: Y yank shortcut implemented correctly"
