#!/bin/bash
# test-inline-rename.sh
# Tests: inline rename function exists with startInlineRename and saveRename helpers

grep -q 'function startInlineRename' /opt/feather-dev/static/index.html || exit 1
grep -q 'function saveRename' /opt/feather-dev/static/index.html || exit 1
# ctxRename should no longer call prompt() directly for current session (uses inline)
grep -q 'startInlineRename(sid, desktopTitle)' /opt/feather-dev/static/index.html || exit 1
exit 0
