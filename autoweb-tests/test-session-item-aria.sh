#!/bin/bash
# test-session-item-aria.sh
# Tests: session list items have role="button", aria-label, aria-current, and onkeydown for accessibility

grep -q 'role="button"' /opt/feather/static/index.html || exit 1
grep -q 'aria-current=' /opt/feather/static/index.html || exit 1
grep -q '_ariaLabel' /opt/feather/static/index.html || exit 1
grep -q "onkeydown=\"if(event.key==='Enter'" /opt/feather/static/index.html || exit 1
exit 0
