# Replication: Sidebar doesn't overlay on mobile

## Steps
1. Open the Feather app at a 390x844 mobile viewport
2. Click the hamburger menu (☰) to open the sidebar
3. Observe the sidebar takes 300px as a static-positioned element in a flex row
4. The main content is pushed into the remaining space (90px on mobile), showing clipped text

## What to check
- The sidebar's first child of the root flex container has `position: static` and `width: 300px`
- On mobile, it should be `position: fixed` or `position: absolute` to overlay content
- A dark backdrop should cover the main content area when sidebar is open

## Root cause
In App.tsx, the sidebar uses `width: sidebar() ? '300px' : '0'` within a flex row layout. On mobile viewports, this pushes the main content into a tiny sliver instead of overlaying it.

## Detection
The `replicate.sh` script opens the sidebar and checks if the sidebar element is `position: static/relative` with width >= 250px. If so, the bug is present (exit 0). If the sidebar uses overlay positioning (fixed/absolute), the bug is absent (exit 1).
