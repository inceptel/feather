#!/bin/bash
# test-command-palette-collapse-tools-id.sh
# Tests: command palette 'Collapse all tools' uses correct button id (tools-toggle-btn)

grep -q "getElementById('tools-toggle-btn')" /opt/feather/static/index.html || exit 1
# Should NOT use the wrong id
grep -q "getElementById('collapse-tools-btn')" /opt/feather/static/index.html && exit 1
exit 0
