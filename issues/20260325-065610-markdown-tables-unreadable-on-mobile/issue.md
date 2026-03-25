# Bug: Markdown tables are unreadable on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on a mobile viewport (`390x844`).
2. Open the `worker 4 probe` session from the drawer.
3. Scroll to the message containing the markdown table titled `Port flip repro results:`.

## Expected behavior
Markdown tables should remain readable on mobile, typically by allowing horizontal scrolling or another responsive presentation.

## Actual behavior
Feather squeezes the entire table into the chat bubble width, forcing every column to wrap into narrow stacked fragments. Values like `Started on 3304` and `3304/#4baa...` break across multiple lines, making the table difficult to read.

## Screenshots
- markdown-table-mobile.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
- URL: `http://localhost:3304/#4baa1292-7fdf-4e87-af47-6731e459b3cd`
