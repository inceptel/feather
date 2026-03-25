# Bug: Rate limit keeps composer enabled

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd` on mobile (`390x844`).
2. Wait for the existing assistant reply `You've hit your limit · resets 5pm (UTC)` to appear in the transcript.
3. Tap the composer and type any new text.

## Expected behavior
Once Feather shows that the user has hit their limit, the composer should switch into a blocked state until reset time, or clearly prevent another send attempt.

## Actual behavior
The transcript shows `You've hit your limit · resets 5pm (UTC)` as a normal chat message, but the textarea stays editable and typing immediately re-enables the green `Send` button. DOM verification on this repro showed `textarea.disabled === false` before and after typing, and `sendDisabled === false`.

## Screenshots
- rate-limit-composer-still-enabled.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium mobile emulation (Selenium)
