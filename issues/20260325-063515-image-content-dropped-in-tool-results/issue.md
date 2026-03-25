# Bug: Image content silently dropped in tool_result OUTPUT cards

## Status
new

## Severity
high

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Open sidebar, select any session that used the Read tool on an image file (PNG, JPG)
3. Scroll to the Read tool card for the image file (e.g., "Read w1/sidebar.png")
4. Look at the OUTPUT card below it

## Expected behavior
The OUTPUT card should display the image (base64-encoded PNG/JPG from the Read tool result), or at minimum show a placeholder like "[Image: image/png]" to indicate image content exists.

## Actual behavior
The OUTPUT card renders as a tiny empty green badge with just the "OUTPUT" header and no content at all. The image data is silently discarded.

## Root cause
In `MessageView.tsx` line 94, the tool_result handler extracts text from content blocks:
```javascript
const raw = typeof block.content === 'string' ? block.content 
  : Array.isArray(block.content) 
    ? block.content.map((c: any) => c.text || '').join('') 
    : ''
```

When `block.content` is an array containing image blocks (`{type: "image", source: {type: "base64", data: "...", media_type: "image/png"}}`), the code does `c.text || ''` which returns empty string for image blocks (they have `source`, not `text`). The entire `raw` string is empty, so no content is rendered.

Confirmed: the current session JSONL has 20 image blocks in tool_result content, all silently dropped.

## Fix suggestion
In the `tool_result` rendering, check for image blocks and render them:
```javascript
// Extract images from array content
const images = Array.isArray(block.content) 
  ? block.content.filter(c => c.type === 'image') 
  : []
// Render images as <img> tags with base64 src
```

## Screenshots
- empty-output-for-image.png — shows "Read w1/sidebar.png" tool card followed by empty OUTPUT badge

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
