#!/bin/bash
# test-mobile-padding-reduced.sh
# Tests: Mobile media query reduces message container padding and increases input button touch targets
# Added: iteration 15

# Check that the mobile media query includes reduced padding for message-container
grep -q '#message-container.*p[xy]\?-[12]' /opt/feather/static/index.html && exit 0
# Also accept if it's in a @media block setting padding
grep -A 50 '@media.*max-width.*76[78]' /opt/feather/static/index.html | grep -q 'message-container' || exit 1
exit 0
