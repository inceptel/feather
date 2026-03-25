# Bug: Composer draft leaks across sessions on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd` on mobile (`390x844`).
2. Type `worker4 iter28 delivery state probe` into the composer without successfully sending it.
3. Open a fresh browser session and load the same session URL.
4. Navigate that fresh browser session to a different session, for example `http://localhost:3304/#50e15da4-b590-4217-b3d6-3ae6fa95db18`.

## Expected behavior
Composer drafts should be cleared on reload or, at minimum, scoped to the current session only. Opening a different session should show an empty composer unless that session has its own saved draft.

## Actual behavior
The unsent text `worker4 iter28 delivery state probe` remained in the composer after opening a fresh browser session and was still present after navigating to a completely different session. The stale draft appears to leak across session boundaries.

## Screenshots
- iter28-after-send.png
- iter28-draft-other-session.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- Session originally typed into: `4baa1292-7fdf-4e87-af47-6731e459b3cd`
- Different session that still showed the same draft: `50e15da4-b590-4217-b3d6-3ae6fa95db18`
