#!/bin/bash
# test-mobile-session-header.sh
# Tests: Mobile session header exists with correct structure (md:hidden, session name span)
# Added: iteration 38

# Check the mobile session header div exists
grep -q 'id="mobile-session-header"' /opt/feather/static/index.html || exit 1

# Check it has md:hidden class (hidden on desktop)
grep -q 'mobile-session-header.*md:hidden' /opt/feather/static/index.html || exit 1

# Check it has the session name span
grep -q 'id="mobile-session-name"' /opt/feather/static/index.html || exit 1

# Check updateMobileSessionHeader function exists
grep -q 'function updateMobileSessionHeader' /opt/feather/static/index.html || exit 1

exit 0
