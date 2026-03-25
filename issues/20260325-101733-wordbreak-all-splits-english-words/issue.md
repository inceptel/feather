# Bug: word-break: break-all splits English words mid-word in tool cards

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Select any session with tool_result OUTPUT cards containing English text
3. Observe how words are broken at arbitrary character boundaries

## Expected behavior
English words should wrap at word boundaries (between words), not mid-word. Only unbreakable strings like file paths, URLs, or base64 data should be split mid-character.

## Actual behavior
`word-break: break-all` is applied to both tool_result OUTPUT cards and tool_use detail `<pre>` elements. This forces line breaks between ANY two characters, causing readable English text to be split mid-word. Examples observed:

- "breadcrumbs.md" → "br\neadcrumbs.md"
- "successfully" → "succes\nsfully"
- "supervisord.conf" → "supe\nrvisord.conf"

## Affected code locations
- `MessageView.tsx:77` — tool_use detail `<pre>` elements: `word-break:break-all` in inline style string
- `MessageView.tsx:100` — tool_result output `<div>`: `'word-break': 'break-all'` in style object

## Prevalence
- 56 out of 128 tool_result cards (43.8%) across 15 sessions contain English words long enough to be affected
- Tool_use `<pre>` elements (Bash commands, Edit diffs, Write content) are also affected
- Both locations use `break-all` instead of a word-aware break strategy

## Suggested fix
Replace `word-break: break-all` with `overflow-wrap: anywhere` (or `word-break: break-word`). This preserves readability by only breaking words at natural boundaries, while still preventing horizontal overflow for long unbreakable strings.

## Screenshots
- wordbreak-output.png — OUTPUT card showing "br\neadcrumbs.md" and "succes\nsfully"
- wordbreak-edit-cards.png — Multiple OUTPUT cards showing "supe\nrvisord.conf" broken mid-word

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
