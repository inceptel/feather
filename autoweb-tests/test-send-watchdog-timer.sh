#!/bin/bash
# test-send-watchdog-timer.sh
# Tests: sendWatchdogTimer variable exists and is used in handleSend SSE fallback
# Added: iter 83

grep -q 'sendWatchdogTimer' /opt/feather/static/index.html || exit 1
grep -q 'Send watchdog.*SSE open but no response' /opt/feather/static/index.html || exit 1
grep -q 'clearTimeout(sendWatchdogTimer)' /opt/feather/static/index.html || exit 1
exit 0
