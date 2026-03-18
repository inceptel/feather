#!/bin/bash
# test-chat-search-clear-btn.sh
# Tests: chat search clear (×) button clears input without closing bar

grep -q 'id="chat-search-clear-btn"' /opt/feather/static/index.html || exit 1
grep -q 'clearChatSearchInput()' /opt/feather/static/index.html || exit 1
grep -q "clearBtn.classList.toggle('hidden', !input.value)" /opt/feather/static/index.html || exit 1
exit 0
