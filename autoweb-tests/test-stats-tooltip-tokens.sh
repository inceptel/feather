#!/bin/bash
# test-stats-tooltip-tokens.sh
# Tests: session stats tooltip includes estimated token count alongside char count

grep -q 'k tokens' /opt/feather-dev/static/index.html || exit 1
exit 0
