#!/bin/bash
# test-export-markdown-shortcut.sh
# Tests: E keyboard shortcut for export session as Markdown is wired up in key handler, shortcuts modal, and command palette
# Added: iter 87

# Check key handler exists
grep -q "e.key === 'e'" /opt/feather/static/index.html || exit 1

# Check key handler calls exportSessionMarkdown
grep -A5 "e.key === 'e'" /opt/feather/static/index.html | grep -q "exportSessionMarkdown" || exit 1

# Check shortcuts modal has E entry
grep -q "Export session as Markdown" /opt/feather/static/index.html || exit 1

# Check command palette entry shows shortcut 'E'
grep "Export session as Markdown" /opt/feather/static/index.html | grep -q "shortcut: 'E'" || exit 1

exit 0
