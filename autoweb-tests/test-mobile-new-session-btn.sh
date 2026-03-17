#!/bin/bash
# test-mobile-new-session-btn.sh
# Tests: mobile-only New Session button exists in sidebar bottom nav bar

grep -q 'id="mobile-new-session-btn"' /opt/feather-dev/static/index.html || exit 1
grep -q 'newClaudeSession()' /opt/feather-dev/static/index.html | grep -q 'mobile-new-session-btn' || \
  grep -A1 'mobile-new-session-btn' /opt/feather-dev/static/index.html | grep -q 'newClaudeSession' || exit 1
grep -q 'md:hidden' /opt/feather-dev/static/index.html | head -1 | grep -q 'mobile-new' || \
  grep 'mobile-new-session-btn' /opt/feather-dev/static/index.html | grep -q 'md:hidden' || exit 1
exit 0
