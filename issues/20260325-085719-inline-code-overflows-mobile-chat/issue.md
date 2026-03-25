# Bug: Long inline code overflows and gets clipped in mobile chat bubbles

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile at `390x844`.
2. Scroll to the `hello old friend` transcript entry that says `Found it. Both are stuck on the OpenAI API rate limit:`.
3. Look at the first inline code span under that sentence: `secondary: used_percent: 75.0, window_minutes: 10080 (7 days)`.

## Expected behavior
Inline code should wrap or otherwise remain fully readable inside the chat bubble on mobile.

## Actual behavior
The inline code span is rendered with `white-space: pre`, grows wider than both its parent bubble and the viewport, and gets clipped on the right. In this capture the code span measures about `435px` wide, while its parent text container is only about `276px` wide on a `390px` viewport.

## Screenshots
- inline-code-overflow.png
- inline-code-overflow-full.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
