#!/bin/bash
# Test: message timestamps show full date as title tooltip on hover
FILE="/opt/feather/static/index.html"

# Check formatMessageTimeFull function exists
grep -q "function formatMessageTimeFull" "$FILE" || { echo "FAIL: formatMessageTimeFull function missing"; exit 1; }

# Check it uses toLocaleString with seconds
grep -q "second.*2-digit\|2-digit.*second" "$FILE" || { echo "FAIL: formatMessageTimeFull missing seconds in format"; exit 1; }

# Check user message timestamp div has title attr using formatMessageTimeFull
grep -q 'title="${escapeHtml(formatMessageTimeFull(timestamp))}"' "$FILE" || { echo "FAIL: user message timestamp missing formatMessageTimeFull title tooltip"; exit 1; }

# Check assistant message timestamp div has title attr
grep -c 'title="${escapeHtml(formatMessageTimeFull(timestamp))}"' "$FILE" | grep -q "^[23]$" || { echo "FAIL: expected 2-3 occurrences of formatMessageTimeFull title tooltip"; exit 1; }

echo "PASS: message timestamps show full date tooltip on hover"
exit 0
