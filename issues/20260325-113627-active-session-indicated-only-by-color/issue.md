# Bug: Active session in drawer is indicated only by color

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for the `hello old friend` chat to load.
3. Open the session drawer with the hamburger button.
4. Compare the active `hello old friend` row with the inactive rows.

## Expected behavior
The current session should have a non-color selected indicator and expose current/selected state to assistive technology, for example with visible text or shape treatment plus `aria-current` or `aria-selected`.

## Actual behavior
The only visible cue is a small green dot before `hello old friend`. The row exposes no `aria-current` or `aria-selected` state, so the current selection is conveyed by color alone.

## Screenshots
- drawer-active-session.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (Playwright)
