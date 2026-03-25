# Replication Instructions

1. Inspect the `handleNew` button in `frontend/src/App.tsx`.
2. Find the button that renders `+ New Claude` in the mobile session drawer.
3. Check its inline styles for mobile touch-target sizing.

The bug is present when that button still uses `padding: '10px'` and does not set a `44px` minimum height. In the current source that style block yields an undersized mobile control, matching the reported roughly `267x36` rendered button.
