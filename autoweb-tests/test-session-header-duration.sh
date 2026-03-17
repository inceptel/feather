#!/bin/bash
# test-session-header-duration.sh
# Tests: session header fetches stats and shows duration in meta

grep -q 'fetchSessionStats' /opt/feather/static/index.html || exit 1
grep -q 'formatDuration' /opt/feather/static/index.html || exit 1
grep -q 'duration_secs' /opt/feather/static/index.html || exit 1
exit 0
