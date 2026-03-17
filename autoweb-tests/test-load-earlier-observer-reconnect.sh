#!/bin/bash
# test-load-earlier-observer-reconnect.sh
# Tests: setupLoadEarlierObserver() is called after renderEarlierMessages() creates a new button
# Added: iteration 89

# After renderEarlierMessages() inserts a new load-earlier-btn, it should call setupLoadEarlierObserver()
# so subsequent scroll-up auto-loads work (not just the first page)
grep -A 20 "remaining > 0" /opt/feather/static/index.html | grep -q "setupLoadEarlierObserver" || exit 1
exit 0
