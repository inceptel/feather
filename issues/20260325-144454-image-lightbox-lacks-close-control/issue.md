# Bug: Image lightbox lacks close control and dialog semantics

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd` on mobile (`390x844`).
2. Scroll to the bottom of the chat transcript until the `lightbox probe` image message is visible.
3. Tap the inline image preview to open it full-screen.

## Expected behavior
Opening an image preview should present an operable modal image viewer with a visible close control and dialog semantics such as an accessible name and `aria-modal="true"`.

## Actual behavior
Feather opens a full-screen dark overlay with the image, but the overlay has no `role`, no `aria-modal`, no accessible label, and no close button. Selenium inspection of the open overlay also showed `document.activeElement` remained on `BODY`, so assistive tech gets no modal context and users only have backdrop tap as the dismissal path.

## Screenshots
- lightbox-before.png
- lightbox-open.png

## Evidence
- `lightbox-evidence.json` shows `overlayExists: true`, `overlayRole: null`, `overlayAriaModal: null`, `overlayAriaLabel: null`, `closeButtons: []`, and `activeElement: "BODY"` after opening the image.

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium via Selenium
