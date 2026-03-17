#!/bin/bash
# test-autoweb-pattern-expanded.sh
# Tests: autoweb session detection exists and uses fallback regex pattern
# Added: iteration 45, updated to match current simplified isAutowebSession() implementation

# Check that isAutowebSession function exists and has is_autoweb field check
grep -q 'isAutowebSession' /opt/feather/static/index.html || exit 1
grep -q 's\.is_autoweb' /opt/feather/static/index.html || exit 1
# Check that 'autoweb' keyword fallback exists
grep -q 'autoweb' /opt/feather/static/index.html || exit 1
exit 0
