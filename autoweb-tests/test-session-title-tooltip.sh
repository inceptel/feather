#!/bin/bash
# test-session-title-tooltip.sh
# Tests: Session items have title attribute for tooltip on truncated names
# Added: iteration 12, updated to match current getSessionTitle() implementation

# The session-item div should have a title attribute showing the full session title
grep -q 'title="${escapeHtml(getSessionTitle(s))}"' /opt/feather/static/index.html || exit 1
exit 0
