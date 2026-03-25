# Bug: Chat attach button missing accessible label

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the session drawer and select `worker 4 probe`.
3. Inspect the chat composer with an accessibility snapshot.

## Expected behavior
The attachment control should expose a descriptive accessible name such as `Attach file`.

## Actual behavior
The control is exposed as a bare `+` button in the accessibility tree. The only descriptive text is a hover tooltip (`title="Attach file"`), which is not a reliable accessible name on mobile or for screen readers.

## Screenshots
- chat-attach-accessibility.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
