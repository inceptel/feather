# Bug: Raw `<tool_use_error>` XML tags displayed in ERROR cards

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Open any session where a tool returned an error (e.g., Worker 3 session)
3. Scroll to an ERROR card (red-bordered tool_result with is_error=true)
4. Observe the error message text

## Expected behavior
The ERROR card should display only the error message text, e.g.:
> File has not been read yet. Read it first before writing to it.

The card is already labeled "ERROR" in the header, so no additional markers are needed.

## Actual behavior
The ERROR card displays raw XML wrapper tags around the error message:
> `<tool_use_error>`File has not been read yet. Read it first before writing to it.`</tool_use_error>`

The `<tool_use_error>` and `</tool_use_error>` tags appear as literal text, making error messages harder to read and looking broken/unprofessional.

## Root cause
In `MessageView.tsx:94`, the tool_result content is extracted as-is:
```typescript
const raw = typeof block.content === 'string' ? block.content : ...
```

When `is_error` is true, the JSONL stores content as:
```json
"content": "<tool_use_error>Error message here</tool_use_error>"
```

The XML wrapper tags are never stripped before rendering.

## Prevalence
- **1,931 instances** across **839 sessions** — this is extremely common
- Every tool error in every session displays these redundant XML tags

## Suggested fix
Strip `<tool_use_error>` tags from the content string before display:
```typescript
let raw = typeof block.content === 'string' ? block.content : ...
raw = raw.replace(/<\/?tool_use_error>/g, '').trim()
```

## Screenshots
- error-tags-visible.png — ERROR card showing `<tool_use_error>File has not been read yet...</tool_use_error>`
- error-tags-bottom.png — Second ERROR card showing `<tool_use_error>Found 28 matches...`

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
