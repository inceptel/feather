#!/bin/bash
# test-mobile-longpress-context.sh
# Tests: session items have data-ctx-id and long-press handler exists

grep -q 'data-ctx-id="${s.id}"' /opt/feather/static/index.html || exit 1
grep -q 'LP_DELAY' /opt/feather/static/index.html || exit 1
grep -q "target.closest('.session-item\[data-ctx-id\]')" /opt/feather/static/index.html || exit 1
exit 0
