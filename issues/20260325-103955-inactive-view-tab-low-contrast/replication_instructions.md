1. Open [App.tsx](/home/user/feather-dev/w5/frontend/src/App.tsx) and find `tabStyle()` above the `Chat` and `Terminal` buttons.
2. Confirm the inactive branch still sets the tab label color to `#666` while the app shell uses the dark `#0a0e14` background.
3. Compute the contrast for `rgb(102, 102, 102)` against `rgb(10, 14, 20)` for the `13px` inactive tab label.
4. The bug is present when that inactive tab treatment stays below the `4.5:1` WCAG AA threshold for normal text, which in the current source is about `3.37:1`.
