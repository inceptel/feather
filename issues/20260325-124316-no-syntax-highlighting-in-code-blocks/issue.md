# Bug: No syntax highlighting in markdown code blocks

## Status
new

## Severity
medium

## Steps to reproduce
1. Open any session that contains markdown code blocks (e.g., session 370e2f60 "hello old friend")
2. Look at code blocks rendered in assistant messages (e.g., ```typescript, ```json blocks)
3. All code renders in a single flat color (#c9d1d9) with no syntax differentiation

## Expected behavior
Code blocks with language tags (```typescript, ```python, ```json, etc.) should render with syntax highlighting — keywords, strings, comments, types in different colors — as users expect from any modern code viewer.

## Actual behavior
All code blocks render in monochrome #c9d1d9 regardless of language. The Marked renderer is configured without a `highlight` callback (MessageView.tsx:8):
```js
const marked = new Marked({ gfm: true, breaks: true })
```

No syntax highlighting library (highlight.js, Prism, shiki) is imported or configured. The CSS explicitly sets a single flat color:
```css
.markdown pre code { color: #c9d1d9; }
```

Marked does add `language-xxx` classes to `<code>` elements, but without a highlight callback these classes go unused.

## Impact
- Feather is a viewer for AI coding agents — the primary content is code
- Without syntax highlighting, code blocks are significantly harder to scan and understand
- Every session with code is affected (the majority of sessions)
- Especially painful for long code blocks (Write tool, Edit tool diffs, agent-generated code)

## Root cause
MessageView.tsx line 8: `new Marked({ gfm: true, breaks: true })` — no `highlight` option set, no syntax highlighting library included in the frontend bundle.

## Suggested fix
Add highlight.js or a similar library:
```js
import hljs from 'highlight.js'
const marked = new Marked({
  gfm: true,
  breaks: true,
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
    return hljs.highlightAuto(code).value
  }
})
```

## Environment
- Viewport: any (affects all viewports)
- Browser: Chromium (agent-browser)
- File: frontend/src/components/MessageView.tsx:8
