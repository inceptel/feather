# Bug: Markdown tables silently clipped — no horizontal scroll

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:PORT/ on mobile (390x844)
2. Load any session with markdown table content in assistant text blocks
3. Observe tables with 3+ columns or wide content

## Expected behavior
Tables that exceed the bubble width should be horizontally scrollable, matching how code blocks (`<pre>`) already work with `overflow-x: auto`.

## Actual behavior
Tables are silently clipped by the parent bubble's `overflow: hidden`. No scrollbar, no indication that content is cut off. Users see an incomplete table with no way to view the hidden columns.

## Root cause

In `MessageView.tsx` line 133, the markdown CSS for tables lacks an overflow wrapper:

```css
.markdown table { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: 0.9em; }
```

Compare with code blocks at line 128, which properly handle overflow:

```css
.markdown pre { margin: 8px 0; border-radius: 6px; overflow-x: auto; ... }
```

The chat bubble container (line 197) sets `overflow: 'hidden'`, which clips any table content that exceeds the bubble width. On mobile at 390px, bubbles are max 85% = ~331px. Even a 3-column table easily exceeds this.

## Data evidence

Searched across all sessions and found markdown tables in text blocks:

| Session | Role | Columns | Max Width |
|---------|------|---------|-----------|
| fe123acb | user | 6 | 309 chars |
| fe123acb | assistant | 3 | 166 chars |
| f0d5b5a9 | assistant | 3 | 76 chars |
| 370e2f60 | assistant | 2 | 51 chars |

At ~8px per character with cell padding, even the 51-char table would overflow the 331px mobile bubble width.

## Suggested fix

Wrap `.markdown table` in a div with `overflow-x: auto`, or use `display: block; overflow-x: auto;` on the table itself. For example:

```css
.markdown table { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: 0.9em; display: block; overflow-x: auto; }
```

Or better, use a Marked renderer hook to wrap `<table>` elements in a scrollable container `<div style="overflow-x:auto">`.

## Screenshots
- table-test.png — app rendering (desktop, no table visible in current view)
- mobile-landing.png — mobile viewport (390x844)

## Environment
- Viewport: 390x844 (mobile) and 1280x800 (desktop)
- Browser: Chromium (agent-browser)
- File: frontend/src/components/MessageView.tsx, lines 128-135
