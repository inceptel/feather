#!/bin/bash
# test-search-auto-open-chat.sh
# Tests: openChatSearch accepts an initialQuery parameter and triggers doChatSearch

grep -q "function openChatSearch(initialQuery = '')" /opt/feather-dev/static/index.html || exit 1
grep -q "doChatSearch(initialQuery)" /opt/feather-dev/static/index.html || exit 1
grep -q "openChatSearch(currentSearchQuery)" /opt/feather-dev/static/index.html || exit 1
exit 0
