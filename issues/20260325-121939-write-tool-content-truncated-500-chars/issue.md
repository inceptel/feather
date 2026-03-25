# Bug: Write tool input content hard-truncated to 500 characters with no expand

## Status
new

## Severity
medium

## Steps to reproduce
1. Open any session that contains a Write tool call where the file content exceeds 500 characters
2. Find the ✏️ Write tool card and expand it (click the `<details>` triangle)
3. Notice the green `<pre>` block shows only the first 500 characters followed by `…`
4. There is no "show more", no scroll, no way to see the remaining content

## Expected behavior
- Write tool cards should show the complete file content when expanded, or at minimum provide an expand mechanism
- Users reviewing what a coding agent wrote should be able to see the full file content
- Consistent with Edit tool cards which show full old_string/new_string without truncation

## Actual behavior
- `MessageView.tsx` line 89 hard-truncates Write tool input to 500 characters:
  ```tsx
  {(inp.content as string).slice(0, 500)}{(inp.content as string).length > 500 ? '…' : ''}
  ```
- The ellipsis `…` is plain text, not interactive — no click-to-expand
- The full content is available in the message data but discarded client-side
- Users cannot see what files a coding agent actually wrote beyond the first 500 characters

## Impact
Analyzed real sessions for Write tool content lengths:
- Session `370e2f60` ("hello old friend"): 16 Write calls, longest content 5,650 chars — **91% of content hidden**
- Session `fe123acb`: 7 Write calls with content > 500 chars, longest **42,905 chars** — 99% hidden
- Affected Write calls include shell scripts, TypeScript components, config files, and documentation
- This makes it impossible to review what files a coding agent created — a core use case for Feather

## Relationship to existing issues
- **Distinct from `tool-output-truncated-200-chars`** which covers `tool_result` content (lines 93-102)
- This bug covers `tool_use` input content specifically for the Write tool (line 89)
- Both bugs share the same pattern: hard truncation with no expand mechanism
- Note: Edit tool cards (lines 84-86) render `old_string` and `new_string` in full with no truncation — inconsistent

## Root cause
`frontend/src/components/MessageView.tsx` line 89:
```tsx
{name === 'Write' && inp.content && <pre style={`...`}>{(inp.content as string).slice(0, 500)}{(inp.content as string).length > 500 ? '…' : ''}</pre>}
```

## Suggested fix
Either remove the 500-char limit (like Edit cards), or wrap in a scrollable container with max-height, or add a "Show full content" toggle.

## Screenshots
- tool-cards-example.png — session view showing tool cards (Bash/Output cards visible; Write cards in this session are beyond the 100-message display limit)

## Environment
- Viewport: 390x844 (mobile) and 1280x800 (desktop)
- Browser: Chromium (agent-browser)
