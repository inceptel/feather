# Bug: Last chat item hides behind the mobile composer

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for the `hello old friend` transcript to load.
3. Look at the last visible uploaded screenshot near the bottom of the chat.

## Expected behavior
The final transcript item should sit fully above the fixed composer so its bottom edge stays readable and tappable.

## Actual behavior
The last uploaded image continues underneath the fixed composer. In the attached evidence, the composer occupies `y=784..844` while the image extends to `y=860.53`, so the bottom `60px` of that message is hidden.

## Screenshots
- composer-overlap.png
- composer-overlap-evidence.json

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium via Selenium
