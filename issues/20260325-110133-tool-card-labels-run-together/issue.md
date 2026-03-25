# Bug: Tool card labels run into their target text on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Stay on the `Chat` tab in the `hello old friend` session.
3. Look at the visible `Edit` and `Bash` tool cards near the top of the transcript.

## Expected behavior
Tool cards should clearly separate the tool name from the file path or command text so the header reads naturally at a glance.

## Actual behavior
The tool header text is concatenated together with no visible separator. In the repro state, the transcript renders labels such as `✂️ Editconf.d/supervisord.conf` and `⚡ Bashecho "=== ALL WORKERS ===" ...` instead of separating `Edit` from the path and `Bash` from the command. That makes the cards look broken and harder to scan quickly on mobile.

## Screenshots
- tool-card-concatenated-labels.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (Selenium)
