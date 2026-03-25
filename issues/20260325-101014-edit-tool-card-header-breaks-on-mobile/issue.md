# Bug: Edit tool card header breaks on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Stay on the `Chat` tab in the `hello old friend` session.
3. Scroll to the `09:07 AM` `Edit` tool cards near the top of the transcript.

## Expected behavior
The `Edit` tool card header should render as one readable label, with the tool name, target path, and modifiers clearly separated.

## Actual behavior
The `Edit` tool card header breaks apart on mobile. In the repro screenshot, the path wraps awkwardly and the `×all` modifier is pushed onto its own orphaned `xall` line, making the tool card header hard to understand at a glance.

## Screenshots
- tool-card-missing-space-top.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
