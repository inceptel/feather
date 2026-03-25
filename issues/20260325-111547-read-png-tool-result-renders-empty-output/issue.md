# Bug: PNG read tool result renders as an empty output card

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the `worker 4 probe` session from the drawer.
3. Scroll to the `07:09 AM` transcript entries around `📄 Read w4/after-send-iter27.png`.
4. Look at the tool result card rendered immediately after that `Read` entry.

## Expected behavior
Reading an image file should render something useful in chat, such as an image preview, file metadata, or an explicit unsupported-file message.

## Actual behavior
Feather renders a separate green `OUTPUT` card with no visible body content at all, so the transcript shows a blank result block after the PNG read.

## Screenshots
- read-png-empty-output-visible.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium via Selenium mobile emulation
