# Bug: Same-turn assistant messages split into separate bubbles

## Status
new

## Severity
high

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Open any session with tool calls (virtually every session)
3. Scroll to find an assistant message that says something before making a tool call

## Expected behavior
When Claude says text and then makes a tool call in the same turn (e.g., "Verify no TIMEOUT left in supervisor config:" followed by a Bash tool call), the text and tool card should appear in a single message bubble, visually grouped as one assistant response.

## Actual behavior
The text and tool card render as **two completely separate bubbles** with:
- Full 16px margin between them
- Separate timestamps on each bubble
- No visual grouping indicating they're from the same turn

This happens because the Claude CLI's JSONL format stores each content block as a separate line entry (one for the text, one for the tool_use). Feather's `parseMessage()` in `lib/parse.js` creates one message per JSONL line, so they become separate messages in the UI.

## Prevalence
- **50 out of 50** sessions in the sidebar are affected
- **221 consecutive same-role message pairs** found across these sessions
- Common patterns: assistant text → assistant tool_use, assistant tool_use → assistant text, user tool_result → user tool_result (parallel tool calls)

## Root cause
In `server.js` line 26-36, `getMessages()` calls `parseMessage()` for each JSONL line. Each line becomes one message object. There's no grouping logic to merge consecutive same-role messages into a single message.

In the Claude API format, a single assistant turn can contain `[text, tool_use, tool_use]` — multiple content blocks in one message. But the CLI's JSONL splits these into separate lines with separate UUIDs. Feather needs to detect and merge them.

## Fix suggestion
In `getMessages()`, after parsing all messages, merge consecutive same-role messages:
```javascript
// After collecting msgs[], merge consecutive same-role entries
const merged = [];
for (const m of msgs) {
  const prev = merged[merged.length - 1];
  if (prev && prev.role === m.role) {
    prev.content = [...prev.content, ...m.content];
  } else {
    merged.push({ ...m, content: [...m.content] });
  }
}
return merged.slice(-limit);
```

## Screenshots
- consecutive.png — shows "Verify no TIMEOUT left in supervisor config:" as one bubble and the Bash grep tool card as a separate bubble below it, both timestamped 09:07 AM

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
