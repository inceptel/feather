# Bug: Mobile drawer squeezes live chat pane into a narrow strip

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` in Feather on mobile at `390x844`.
2. Tap the hamburger button to open the session drawer.
3. Observe the right side of the screen while the drawer is open.

## Expected behavior
The mobile drawer should fully cover or cleanly overlay the main pane so the background chat UI does not reflow into a tiny visible strip.

## Actual behavior
Opening the drawer leaves a live slice of the chat pane visible on the right side of the screen. In the captured state, the active pane is squeezed so hard that `Select a session` wraps into a vertical fragment, only part of the `Chat` tab remains visible, and the composer controls are shoved into the bottom-right corner.

Measured in the same mobile state via `getBoundingClientRect()`:
- `Chat` tab: `x=316`, `width≈60.9`
- `Terminal` tab: `x≈376.9`, `right≈462.1` on a `390px` viewport
- composer textarea: `x≈339.7`, `width=30`
- `Send` button: `x≈377.7`, `right≈446.4` on a `390px` viewport

This is distinct from the non-modal accessibility bug: the drawer also causes a visible layout collapse and pushes core chat UI off-screen.

## Screenshots
- session-mobile-recheck.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
