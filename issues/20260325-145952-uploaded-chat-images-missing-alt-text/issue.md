# Bug: Uploaded chat images missing alt text

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Attach an image in the composer and send it into the chat.
3. Inspect the rendered message bubble that shows the uploaded image.

## Expected behavior
Uploaded images in the transcript should expose a text alternative, such as meaningful `alt` text or another accessible name, so screen reader users are told what the image is or that it is an attached image.

## Actual behavior
The rendered transcript image and its lightbox copy are both bare `<img>` elements with no `alt`, `aria-label`, or semantic role. The DOM capture in `image-alt-evidence.json` shows two `/uploads/...` images and both report `alt: null`.

## Screenshots
- image-message-bottom.png
- image-alt-evidence.json

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium mobile emulation
- Route: `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf`
