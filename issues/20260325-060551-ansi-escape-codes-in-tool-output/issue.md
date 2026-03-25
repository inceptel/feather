# Bug: ANSI escape codes render as garbage in tool output cards

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Open any session that ran CLI commands (e.g. agent-browser, git)
3. Look at the OUTPUT cards (tool_result blocks) for those commands

## Expected behavior
Tool output should display clean, readable text. ANSI color/formatting codes should be stripped before rendering.

## Actual behavior
ANSI escape sequences like `\x1b[32m`, `\x1b[0m`, `\x1b[1m`, `\x1b[31m` render as visible replacement characters (boxes/diamonds) followed by literal text like `[32m`, `[0m`, etc. Example output that should read:

```
✓ Feather
  http://localhost:3301/
✓ Done
```

Instead renders as something like:

```
□[32m✓□[0m □[1mFeather□[0m
  □[2mhttp://localhost:3301/□[0m
□[32m✓□[0m Done
```

## Scope
- 32 tool_result messages with ANSI codes found across just 15 sessions checked
- Affects any Bash command output that uses color codes (agent-browser, git, npm, supervisorctl, etc.)
- The ANSI codes come from CLI tools that output colored text

## Root cause
In `MessageView.tsx` line 94, tool_result content is extracted as raw text:
```tsx
const raw = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((c: any) => c.text || '').join('') : ''
```
No ANSI stripping is applied before rendering in the div at line 100.

## Suggested fix
Strip ANSI escape codes before rendering tool_result text:
```tsx
const raw = (typeof block.content === 'string' ? block.content : ...).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
```

## Screenshots
- session-with-tool-output.png — shows the session view with OUTPUT cards (tool results)

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
