# Bug: Raw `<persisted-output>` XML tags displayed in OUTPUT cards

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Open sidebar, select session at position 2 (Worker 3 session 1c56b7af)
3. Scroll up to message 5 — a Read tool_result OUTPUT card
4. Observe `<persisted-output>` and `</persisted-output>` tags rendered as literal visible text

## Expected behavior
The `<persisted-output>` wrapper tags should be stripped before rendering. Only the inner content (the "Output too large..." summary and preview) should be displayed.

## Actual behavior
The raw XML tags `<persisted-output>` and `</persisted-output>` are rendered as visible literal text at the beginning and end of OUTPUT cards. Users see internal Claude Code system markup.

The `<persisted-output>` tag is a Claude Code internal wrapper around truncated tool outputs. It should never be shown to end users.

## Scope
- 10+ sessions in the top 50 currently have `<persisted-output>` tags in their API response
- 41 total occurrences across 12 sessions in the full dataset (including subagents)
- Affects tool_result content blocks of type "tool_result" where output was truncated by Claude Code

## Related
- Same class of bug as `raw-xml-tags-in-error-cards` (issue filed earlier for `<tool_use_error>` tags)
- Server and frontend code have no stripping logic for `<persisted-output>` tags

## Suggested fix
In server.js message parsing, strip `<persisted-output>...</persisted-output>` wrapper tags from tool_result content, keeping the inner text. Similar to how `<tool_use_error>` should be stripped.

Example regex: `text.replace(/<\/?persisted-output>/g, '')`

## Screenshots
- persisted-output-visible.png — OUTPUT card showing raw `<persisted-output>` tag

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
