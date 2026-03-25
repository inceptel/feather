# Bug: Session list items are not exposed as interactive controls on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile viewport `390x844`.
2. Tap the hamburger button to open the session drawer.
3. Run an accessibility snapshot or try to target a session row via standard interactive controls.

## Expected behavior
Existing sessions should be exposed as tappable interactive controls so users can select them reliably and assistive technology can announce them.

## Actual behavior
The drawer shows many visible session rows, but the accessibility tree only exposes the close button and `+ New Claude`. The session rows are plain text nodes rather than interactive controls, so they are not discoverable to assistive technology and cannot be targeted as normal tappable elements.

## Screenshots
- landing.png
- sidebar.png
- session-open.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
