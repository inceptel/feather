#!/bin/bash
# test-command-palette-footer.sh
# Tests: Command palette has a keyboard hint footer (↑↓ Navigate)
# Added: iter 102

grep -q 'command-palette-footer\|Navigate.*Enter.*Esc\|↑↓' /opt/feather/static/index.html || exit 1
exit 0
