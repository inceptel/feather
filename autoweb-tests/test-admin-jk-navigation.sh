#!/bin/bash
# Test: Admin page has j/k keyboard shortcuts for navigating between service cards
FILE="/opt/feather/static/admin/index.html"

# Check navigateServices function exists
if ! grep -q "function navigateServices" "$FILE"; then
    echo "FAIL: navigateServices function not found"
    exit 1
fi

# Check j/k key handlers exist
if ! grep -q "e.key === 'j'" "$FILE"; then
    echo "FAIL: 'j' key handler not found"
    exit 1
fi
if ! grep -q "e.key === 'k'" "$FILE"; then
    echo "FAIL: 'k' key handler not found"
    exit 1
fi

# Check data-svc-name attribute used for card selection
if ! grep -q "data-svc-name" "$FILE"; then
    echo "FAIL: data-svc-name attribute not found on service cards"
    exit 1
fi

# Check ring highlight is applied on navigation
if ! grep -q "ring-gold-9" "$FILE"; then
    echo "FAIL: ring-gold-9 focus highlight not found"
    exit 1
fi

# Check j/k documented in shortcuts panel
if ! grep -q "Focus next service\|Focus prev service" "$FILE"; then
    echo "FAIL: j/k shortcuts not documented in shortcuts panel"
    exit 1
fi

echo "PASS: Admin j/k keyboard navigation for service cards"
exit 0
