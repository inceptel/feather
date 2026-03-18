#!/bin/bash
# Test zen mode persists to localStorage
INDEX="/opt/feather/static/index.html"

# Check toggleZenMode saves to localStorage
grep -q "feather-zen-mode" "$INDEX" || { echo "FAIL: feather-zen-mode localStorage key not found"; exit 1; }

# Check that active state is saved
grep -A5 "active = document.body.classList.toggle('zen-mode')" "$INDEX" | grep -q "localStorage.setItem.*feather-zen-mode" || { echo "FAIL: zen mode state not saved to localStorage after toggle"; exit 1; }

# Check restore on load
grep -q "localStorage.getItem('feather-zen-mode') === '1'" "$INDEX" || { echo "FAIL: zen mode restore on load not found"; exit 1; }

# Check it adds zen-mode class on restore
grep -A2 "localStorage.getItem('feather-zen-mode') === '1'" "$INDEX" | grep -q "classList.add('zen-mode')" || { echo "FAIL: zen-mode class not added on restore"; exit 1; }

echo "PASS: Zen mode persists to localStorage across page reloads"
