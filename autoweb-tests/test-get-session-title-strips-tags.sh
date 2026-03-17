#!/bin/bash
# test-get-session-title-strips-tags.sh
# Tests: getSessionTitle strips <command-message> and similar XML tags from session titles

grep -q "stripSystemTags(raw).trim()" /opt/feather/static/index.html || exit 1
exit 0
