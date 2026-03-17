#!/bin/bash
# test-sidebar-inline-rename.sh
# Tests: sidebar session items have ondblclick for inline rename and session-item-title class

grep -q 'ondblclick="sidebarInlineRename' /opt/feather/static/index.html || exit 1
grep -q 'session-item-title' /opt/feather/static/index.html || exit 1
grep -q 'function sidebarInlineRename' /opt/feather/static/index.html || exit 1
exit 0
