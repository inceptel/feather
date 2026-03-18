#!/bin/bash
# test-chat-search-match-case.sh
# Tests: chat search match-case toggle button (Aa) exists and toggleChatSearchCase function

FILE=/opt/feather/static/index.html

# Check Aa button exists in chat search bar
grep -q 'id="chat-search-case-btn"' "$FILE" || { echo "FAIL: chat-search-case-btn missing"; exit 1; }

# Check button calls toggleChatSearchCase
grep -q 'toggleChatSearchCase()' "$FILE" || { echo "FAIL: toggleChatSearchCase call missing"; exit 1; }

# Check toggleChatSearchCase function exists
grep -q 'function toggleChatSearchCase' "$FILE" || { echo "FAIL: toggleChatSearchCase function missing"; exit 1; }

# Check _chatSearchCaseSensitive variable
grep -q '_chatSearchCaseSensitive' "$FILE" || { echo "FAIL: _chatSearchCaseSensitive state missing"; exit 1; }

# Check regex uses the flag variable
grep -q 'regexFlags' "$FILE" || { echo "FAIL: regexFlags variable missing"; exit 1; }

echo "PASS: chat search match-case toggle implemented"
