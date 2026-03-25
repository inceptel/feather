# Bug: Tool Result Cards Rendered on the User Side

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Scroll to the `11:42 AM` exchange containing `w5 repro probe 1774438929`.
3. Look at the green `OUTPUT` cards that show the Bash results.

## Expected behavior
Tool results should render with assistant/tool styling on the left, separate from the user's own chat bubbles.

## Actual behavior
The `OUTPUT` cards render inside the green right-aligned user column, so machine-generated tool output appears to be authored by the user.

## Screenshots
- no-output-card-top.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (Playwright)
