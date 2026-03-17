#!/bin/bash
# test-session-filter-pill-touch-targets.sh
# Tests: session filter pills (Mine/Auto/All) have min-height on mobile for tap targets

# Check that mobile media query includes min-height for session-filter-pill
grep -q 'session-filter-pill.*min-height\|\.session-filter-pill[^}]*min-height' /opt/feather/static/index.html || exit 1
exit 0
