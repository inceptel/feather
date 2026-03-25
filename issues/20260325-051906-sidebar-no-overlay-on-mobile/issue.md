# Bug: Sidebar doesn't overlay on mobile — pushes content, leaving clipped text visible

## Status
new

## Severity
high

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Tap the hamburger menu (☰) to open the sidebar

## Expected behavior
On a 390px mobile viewport, the sidebar should either:
- Take the full viewport width as an overlay, or
- Have a dark backdrop covering the main content area behind it

## Actual behavior
The sidebar opens at a fixed 300px width within a flex layout, pushing the main content area into a 90px sliver on the right side. This creates a cluttered, broken appearance where:
- Clipped text from the main area is visible: "Sele", "a", "sessi", "Open a session or create a new one"
- The main content is not dimmed or hidden
- Users can see partially rendered UI elements behind the sidebar

The root cause is in App.tsx — the sidebar uses `width: sidebar() ? '300px' : '0'` in the flex layout instead of being positioned as a mobile overlay.

## Screenshots
- sidebar-bug.png — sidebar open showing clipped main content on right edge

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
