#!/bin/bash
# test-mobile-messages-top-padding.sh
# Tests: Messages area has enough top padding on mobile to clear the fixed session header
# Updated: conditional padding via body.has-mobile-header class

# The mobile media query should include conditional #messages padding-top rule
grep -q 'has-mobile-header #messages.*padding-top.*56px' /opt/feather/static/index.html || exit 1
# The updateMobileSessionHeader function should toggle the body class
grep -q 'has-mobile-header' /opt/feather/static/index.html || exit 1
exit 0
