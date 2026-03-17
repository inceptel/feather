#!/bin/bash
# test-draft-indicator-tooltip.sh
# Tests: draft indicator tooltip shows draft text preview (not generic 'Unsent draft')

grep -q 'draft.substring(0, 60)' /opt/feather-dev/static/index.html || exit 1
exit 0
