#!/bin/bash
# test-empty-state-shortcuts-hidden-mobile.sh
# Tests: #empty-state-shortcuts is hidden in mobile media query

grep -q 'empty-state-shortcuts.*display: none' /opt/feather/static/index.html || exit 1
exit 0
