# Bug: Empty assistant bubbles rendered for zero-length thinking blocks

## Status
new

## Severity
low

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Open the sidebar and select "hello old friend" session
3. Switch to Chat tab
4. Scroll to 08:35 AM area

## Expected behavior
Assistant messages containing only an empty thinking block (0-length content) should not render any visible UI element, or should be completely hidden.

## Actual behavior
A tiny dark bubble (~28x20px) is rendered with just padding and no content, followed by a timestamp. The bubble HTML is:
```html
<div style="padding: 10px 14px; border-radius: 16px 16px 16px 4px; background: rgb(26, 26, 46);">
  <div></div>  <!-- empty -->
</div>
```

The empty bubble adds visual noise between real messages and takes up ~35px of vertical space.

## Impact
- 3062 empty thinking blocks across 126 sessions
- 4 visible instances in "hello old friend" session (at 08:35 AM, 08:48 AM, 08:50 AM, 08:51 AM)
- Each empty bubble wastes ~35px vertical space and confuses the conversation flow

## Screenshots
- empty-bubble.png — shows the tiny dark dot between messages at 08:35 AM
- context-view.png — wider view of the session showing tool cards nearby

## Root cause
When an assistant message contains only a `thinking` block with empty string content (`"thinking":""`), the message renderer still creates a bubble div with padding but no visible content inside it.

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
