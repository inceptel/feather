# Bug: Mobile menu button missing disclosure state semantics

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Inspect the hamburger button before opening the drawer.
3. Tap the hamburger button to open the sidebar drawer.
4. Inspect the same control again in the open state.

## Expected behavior
The drawer toggle should expose disclosure semantics so assistive technology can understand and announce the control state, for example:
- `aria-expanded="false"` while closed
- `aria-expanded="true"` while open
- `aria-controls` pointing at the controlled drawer element

## Actual behavior
The hamburger button is exposed only as a plain button with text `☰` / `×`. DOM inspection showed `aria-expanded` and `aria-controls` were `null` in both the closed and open states, so screen reader users get no state or relationship information for the primary navigation drawer.

## Screenshots
- menu-before.png
- menu-after.png

## Evidence
Closed-state DOM inspection:
```json
{"text":"☰","ariaExpanded":null,"ariaControls":null}
```

Open-state DOM inspection:
```json
{"text":"×","ariaExpanded":null,"ariaControls":null}
```

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
