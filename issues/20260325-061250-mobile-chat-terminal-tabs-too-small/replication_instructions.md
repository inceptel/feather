# Replication Instructions

1. Open `frontend/src/App.tsx`.
2. Find `tabStyle()` near the tab controls used by the `Chat` and `Terminal` buttons.
3. Note that the shared style sets `padding: '6px 16px'` and `'font-size': '13px'`.
4. Estimate the rendered control height from that style: `6px` top padding + `13px` text + `6px` bottom padding + roughly `4px` line box/border contribution = about `29px`.
5. Compare that to the common `44px` mobile touch target minimum.

Because both tabs use the same `tabStyle()`, the shared mode switcher is undersized on mobile and reproduces the reported bug.
