#!/bin/bash
# test-version-indicator-et.sh
# Tests: Version indicator shows ET timezone and compact format
# Added: iteration 21

# Check that the version indicator script converts to ET timezone
grep -q "America/New_York" /opt/feather/static/index.html || exit 1

# Check compact format uses "AW" prefix instead of verbose "autoweb v"
grep -q '"AW "' /opt/feather/static/index.html || exit 1

# Check it uses "fixes" not "improvements" for brevity
grep -q 'fixes' /opt/feather/static/index.html || exit 1

# Check right padding prevents overflow
grep -q 'right:8px\|right: 8px' /opt/feather/static/index.html || exit 1

# Check max-width or white-space:nowrap to prevent wrapping
grep -q 'white-space:\s*nowrap\|whiteSpace.*nowrap' /opt/feather/static/index.html || exit 1

exit 0
