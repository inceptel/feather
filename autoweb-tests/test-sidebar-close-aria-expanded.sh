#!/bin/bash
# Test: closeSidebarMobile() updates aria-expanded on hamburger button

FILE="/opt/feather/static/index.html"

# Check that closeSidebarMobile sets aria-expanded to false on menu-btn
if grep -q "menuBtn.setAttribute('aria-expanded', 'false')" "$FILE"; then
    echo "PASS: closeSidebarMobile() resets aria-expanded to false"
    exit 0
else
    echo "FAIL: closeSidebarMobile() does not reset aria-expanded on hamburger button"
    exit 1
fi
