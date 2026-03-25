# Bug: Tool output (tool_result) hard-truncated to 200 characters with no way to expand

## Status
new

## Severity
high

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Select any session with tool usage (e.g., "hello old friend")
3. Scroll to an OUTPUT card for a Bash command or Read result that returned more than 200 characters
4. Notice the output ends with `…` but there is no way to tap/click to see the full output

## Expected behavior
- Tool output cards should show a preview but allow expanding to see full content
- A "Show more" button or expandable `<details>` element should reveal the complete output
- Critical tool results (file contents, error logs, command output) should be fully accessible

## Actual behavior
- `MessageView.tsx` line 95: `const preview = raw.slice(0, 200)` — hard-truncates ALL tool_result content to 200 characters
- Line 100: `{raw.length > 200 ? '…' : ''}` — shows ellipsis but it is not interactive
- The remaining content is discarded client-side with no mechanism to view it
- Users cannot see the complete output of any tool that returns more than 200 characters

## Impact
Analyzed 50 most recent sessions:
- **120 out of 409** tool_result blocks (29.3%) exceed 200 characters and are truncated
- Worst cases: 22,511 chars, 16,672 chars, 5,556 chars — all cut to just 200 chars
- Affected outputs include: full file contents (Read), command output (Bash), search results (Grep), error traces
- This makes Feather unusable for reviewing what a coding agent actually did — the core use case of the app

## Root cause
`frontend/src/components/MessageView.tsx` lines 93-102:
```tsx
if (block.type === 'tool_result') {
    const raw = typeof block.content === 'string' ? block.content : ...
    const preview = raw.slice(0, 200)  // <-- hard truncation
    ...
    {preview && <div ...>{preview}{raw.length > 200 ? '…' : ''}</div>}  // <-- no expand
}
```

## Suggested fix
Wrap the output in a `<details>` element (like tool_use cards already do) with a summary showing the first 200 chars and the full content available on click.

## Screenshots
- tool-output-truncated.png — session view showing OUTPUT cards (note: the visible card in this screenshot shows a short output, but 29.3% of outputs are longer than 200 chars)

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
