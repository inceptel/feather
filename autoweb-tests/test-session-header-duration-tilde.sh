#!/bin/bash
# test-session-header-duration-tilde.sh
# Tests: session header duration shows ~Xm prefix (not bare Xm) to distinguish from time-ago

grep -q "'~' + dur" /opt/feather/static/index.html || exit 1
grep -q "'Duration: '" /opt/feather/static/index.html || exit 1
exit 0
