# Bug: No-output tool result body is missing on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3302/` on mobile (`390x844`) and stay in the active chat session (`hello old friend` in this run).
2. Scroll to the `11:42 AM` command `Bash ls ~/feather-aw/w5/logs/ | grep "17744389"`.
3. Look at the following green `OUTPUT` result card.

## Expected behavior
When a tool finishes with no stdout, the result card should visibly render the explanatory body text, such as `(Bash completed with no output)`.

## Actual behavior
The transcript text still contains the no-output message, but the rendered mobile UI collapses that tool result into a tiny green `OUTPUT` pill with no visible body content.

## Screenshots
- current-state.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
