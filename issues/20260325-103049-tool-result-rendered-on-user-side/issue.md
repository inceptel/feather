# Bug: tool_result OUTPUT/ERROR cards rendered right-aligned on user side

## Status
new

## Severity
high

## Steps to reproduce
1. Open http://localhost:3301/ on any viewport
2. Select any session that has tool usage (Read, Write, Bash, etc.)
3. Observe the chat layout

## Expected behavior
Tool results (OUTPUT/ERROR cards) should be visually grouped with or near their corresponding tool call on the assistant (left) side. This matches the behavior of claude.ai and other Claude UIs, where tool calls and results are rendered as a single assistant-side block. Tool results are automated system responses to the assistant's tool invocations, not user-initiated messages.

## Actual behavior
Tool results are rendered right-aligned on the user side because they have `role: 'user'` in the Claude API. This creates a confusing zigzag layout:

```
LEFT:  assistant tool_use (Read)
RIGHT: user tool_result (OUTPUT)     ← wrong side
LEFT:  assistant tool_use (Bash)
RIGHT: user tool_result (OUTPUT)     ← wrong side
LEFT:  assistant text
```

The conversation bounces back and forth between left and right sides for every tool call/result pair, making it very difficult to follow the conversation flow.

## Impact
- **35.6% of all messages** are tool_result messages affected by this (166/466 across 20 sessions)
- Every session with tool usage is affected (virtually all sessions)
- The zigzag pattern makes it harder to visually trace the assistant's workflow
- Users see OUTPUT/ERROR cards mixed with their own messages on the right side, creating confusion about what they sent vs what the system returned

## Root cause
In `MessageView.tsx`, message alignment is determined solely by `msg.role`:
- `msg.role === 'user'` → right-aligned (flex-end)
- `msg.role === 'assistant'` → left-aligned (flex-start)

In the Claude API, `tool_result` blocks always have `role: 'user'`, so they get right-aligned. The fix is to check if a user message contains only `tool_result` content blocks and render it left-aligned (assistant side) instead.

Relevant code (MessageView.tsx:192):
```tsx
'align-items': msg.role === 'user' ? 'flex-end' : 'flex-start'
```

Suggested fix:
```tsx
const isToolResult = msg.role === 'user' && msg.content?.every(b => b.type === 'tool_result')
'align-items': (msg.role === 'user' && !isToolResult) ? 'flex-end' : 'flex-start'
```

The bubble background color should also be adjusted for tool_result messages (use assistant-style dark blue instead of user green).

## Screenshots
- zigzag.png — Desktop view showing tool_use (left) and tool_result OUTPUT (right) alternating sides

## Environment
- Viewport: 1280x800 (desktop), also affects 390x844 (mobile)
- Browser: Chromium (agent-browser)
