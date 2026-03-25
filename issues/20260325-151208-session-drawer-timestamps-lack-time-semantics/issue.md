# Bug: Session drawer timestamps lack time semantics

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Tap the hamburger button to open the session drawer.
3. Observe the visible relative timestamps beside session rows such as `2m`, `3m`, and `10m`.
4. Inspect the drawer DOM.

## Expected behavior
Visible session recency labels should be exposed with semantic time markup, such as `<time datetime="...">`, so assistive tech can identify them as timestamps.

## Actual behavior
The drawer renders visible relative age labels, but the page exposes zero `<time>` elements. The recency text is plain text only, so the session list loses timestamp semantics.

## Screenshots
- iter-drawer-open.png

## Evidence
- DOM inspection on the open drawer returned `timeElementCount: 0` while visible labels included `2m`, `3m`, `7m`, `10m`, `13m`, and `18m`.

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
