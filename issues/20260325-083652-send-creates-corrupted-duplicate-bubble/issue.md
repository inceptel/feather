# Bug: Sending a message creates a second corrupted duplicate bubble

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. In the `hello old friend` session, type `worker4 iter42 delivery check`.
3. Tap `Send`.

## Expected behavior
The chat should append one user bubble with the submitted text and then show normal delivery state for that same message.

## Actual behavior
Feather appends the expected user bubble, then immediately renders a second extra bubble underneath it with corrupted text beginning with a raw control-sequence prefix (`\u0001dworker4 iter42 delivery check`). The sent message appears duplicated and visually broken.

DOM inspection after the send found both:
- `worker4 iter42 delivery check`
- `\u0001dworker4 iter42 delivery check`

## Screenshots
- after-send-iter42.png
- after-send-iter42-full.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
