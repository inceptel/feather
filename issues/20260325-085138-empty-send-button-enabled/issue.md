# Bug: Empty composer leaves Send button enabled on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#70fd21d1-cd91-406c-8ab6-a83785c0fc2e` on mobile (`390x844`).
2. Leave the composer textarea empty.
3. Observe that the `Send` button is still enabled.
4. Tap `Send`.

## Expected behavior
The primary send action should be disabled until the user enters message text, or the tap should produce a clear validation error.

## Actual behavior
The `Send` button remains enabled with an empty textarea, but tapping it silently does nothing. During verification, the session stayed at 20 messages before and after the tap.

## Screenshots
- empty-send-enabled.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
- Session: `70fd21d1-cd91-406c-8ab6-a83785c0fc2e`
