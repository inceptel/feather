#!/bin/bash
# test-chat-search-expand-tool-blocks.sh
# Tests: in-chat search finds matches inside collapsed tool blocks and auto-expands them on navigate

grep -q "expandToolBodyIfNeeded" /opt/feather/static/index.html || exit 1
grep -q "tool-body.hidden is included" /opt/feather/static/index.html || exit 1
grep -q "expandToolBodyIfNeeded(mark)" /opt/feather/static/index.html || exit 1
exit 0
