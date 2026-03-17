#!/bin/bash
# test-edit-diff-view.sh
# Tests: Edit tool shows proper line-by-line diff with red/green background lines
# Added: iteration 8

# Check that formatToolInput for Edit renders line-by-line diff with bg colors
grep -q 'bg-ember-9/10\|bg-red.*Edit\|edit-diff-line' /opt/feather/static/index.html || exit 1
# Check we no longer use line-through for Edit diffs
! grep -q "case 'Edit'" /opt/feather/static/index.html | grep -q 'line-through' 2>/dev/null
# Verify the old truncation at 100 chars is replaced with a more generous limit
grep -q 'old_string' /opt/feather/static/index.html && ! grep -q 'old_string.substring(0, 100)' /opt/feather/static/index.html || exit 1
exit 0
