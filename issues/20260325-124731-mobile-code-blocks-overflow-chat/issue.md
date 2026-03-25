# Bug: Markdown code blocks overflow chat bubbles on mobile

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Scroll to the assistant message starting with `There it is! w5 found it:`.
3. Inspect the fenced JSON code block rendered inside that chat bubble.

## Expected behavior
Markdown code blocks should fit within the mobile chat bubble, either by wrapping long lines or presenting them without forcing wide horizontal overflow.

## Actual behavior
The fenced code block renders far wider than the bubble on mobile. In the reproduced case, the `<code>` element measured about `799px` wide inside a `276px`-wide `<pre>` block (`scrollWidth: 823px`), so the JSON line is clipped and requires horizontal scrolling inside the chat bubble.

## Screenshots
- code-overflow-focus.png

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium via Selenium mobile emulation
