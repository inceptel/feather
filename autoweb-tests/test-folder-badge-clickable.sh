#!/bin/bash
# test-folder-badge-clickable.sh
# Tests: folder badge in session list is a clickable button that filters by project

grep -q "onclick.*stopPropagation.*selectFolder" /opt/feather/static/index.html || exit 1
grep -q "hover:text-gold-9" /opt/feather/static/index.html || exit 1
exit 0
