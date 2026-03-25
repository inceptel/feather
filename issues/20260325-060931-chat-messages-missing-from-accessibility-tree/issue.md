# Bug: Chat messages missing from accessibility tree

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the session drawer and select `worker 4 probe`.
3. Observe that the session loads and visible chat bubbles render in the main pane.
4. Capture an accessibility snapshot with `agent-browser --session-name <session> snapshot -i`.
5. Send a message such as `iteration 15 send check` and capture another accessibility snapshot.

## Expected behavior
Visible chat transcript content should be exposed in the accessibility tree so screen readers can read the conversation history and newly sent messages.

## Actual behavior
The accessibility snapshot only exposes the header controls and composer (`☰`, `Resume`, `Chat`, `Terminal`, `+`, textbox, `Send`). None of the visible chat bubbles or transcript text are present in the accessibility tree, even after sending a new message that renders on screen.

## Screenshots
- worker4-probe-click-result.png
- after-send-iter15.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
- Verified on: `http://localhost:3304/` at `2026-03-25T06:09:31Z`
