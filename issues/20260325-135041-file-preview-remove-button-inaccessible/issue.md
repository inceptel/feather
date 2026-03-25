# Bug: File preview remove button is tiny and unlabeled on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Add any attachment so Feather renders a file preview chip above the composer.
3. Inspect the circular `×` button used to remove that pending attachment.

## Expected behavior
The remove control should meet mobile touch-target guidance and expose a descriptive accessible name such as `Remove attachment`.

## Actual behavior
The remove control is rendered as a bare `×` button with no `aria-label` or other accessible name, and its bounding box is only about `18x18` CSS pixels on mobile.

## Evidence
- DOM inspection reported the preview remove button as `text: "×"`, `aria: null`, `title: null`, `rect: { width: 18, height: 18 }`.

## Screenshots
- file-preview-state.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
