#!/bin/bash
# Test focus mode persists to localStorage
INDEX="/opt/feather/static/index.html"

# Check feather-focus-mode localStorage key is used
grep -q "feather-focus-mode" "$INDEX" || { echo "FAIL: feather-focus-mode localStorage key not found"; exit 1; }

# Check that state is saved to localStorage in toggleFocusMode
grep -A20 "function toggleFocusMode" "$INDEX" | grep -q "localStorage.setItem.*feather-focus-mode" || { echo "FAIL: focus mode state not saved to localStorage after toggle"; exit 1; }

# Check restore on load
grep -q "localStorage.getItem('feather-focus-mode') === '1'" "$INDEX" || { echo "FAIL: focus mode restore on load not found"; exit 1; }

# Check it sets focusModeActive = true on restore
grep -A3 "localStorage.getItem('feather-focus-mode') === '1'" "$INDEX" | grep -q "focusModeActive = true" || { echo "FAIL: focusModeActive not set to true on restore"; exit 1; }

# Check it adds focus-mode class on restore
grep -A5 "localStorage.getItem('feather-focus-mode') === '1'" "$INDEX" | grep -q "classList.add('focus-mode')" || { echo "FAIL: focus-mode class not added on restore"; exit 1; }

echo "PASS: Focus mode persists to localStorage across page reloads"
