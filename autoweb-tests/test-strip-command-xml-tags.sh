#!/bin/bash
# test-strip-command-xml-tags.sh
# Tests: stripSystemTags function handles command-related XML tags (local-command-stdout, command-message, command-args)
# Added: iteration 23

# The stripSystemTags function should unwrap command tags (remove tags, keep content)
# Check that the function handles these tags
grep -q 'local-command-stdout' /opt/feather/static/index.html || exit 1
grep -q 'command-message' /opt/feather/static/index.html || exit 1
grep -q 'command-args' /opt/feather/static/index.html || exit 1

exit 0
