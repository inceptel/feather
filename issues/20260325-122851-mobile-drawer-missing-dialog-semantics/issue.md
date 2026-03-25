# Bug: Mobile drawer missing dialog semantics

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`) in Chromium via `agent-browser`.
2. Tap the hamburger button to open the session drawer.
3. Inspect the open drawer container in the DOM.

## Expected behavior
The mobile drawer should be exposed as a modal dialog, for example with `role="dialog"` and `aria-modal="true"`, so assistive tech can treat it as an overlay.

## Actual behavior
The open drawer is built from plain `div` containers with no `role`, no `aria-modal`, and no accessible label. DOM inspection on the open overlay found the matching drawer nodes all reporting `role: null` and `ariaModal: null` while the drawer was visibly open in `drawer-semantics.png`.

## Screenshots
- drawer-semantics.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
