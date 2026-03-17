#!/bin/bash
# test-sticky-session-headers.sh
# Tests: session list group headers (Today/Yesterday/Starred) have sticky positioning

grep -q 'sticky top-0 z-10.*background:var(--smoke-2)' /opt/feather/static/index.html || \
grep -q "sticky top-0 z-10" /opt/feather/static/index.html && \
grep -q "background:var(--smoke-2)" /opt/feather/static/index.html || exit 1
exit 0
