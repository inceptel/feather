# Bug: Non-detail tool cards expand to empty space when tapped

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ on mobile (390x844)
2. Navigate to any session with Read, Grep, Glob, WebFetch, or WebSearch tool cards
3. Tap on a Read tool card (e.g., "📄 Read logs/iteration-0022-1774420468.log")
4. Observe the card expands but shows nothing inside

## Expected behavior
Non-expandable tool cards (Read, Grep, Glob, WebFetch, WebSearch, Skill) should either:
- Not be wrapped in `<details>` elements (use a plain `<div>` instead), OR
- Show useful detail content when expanded (e.g., Read could show the file path, Grep could show the pattern/path)

## Actual behavior
All tool_use blocks are wrapped in `<details>` HTML elements (`MessageView.tsx:79`). For tools where `hasDetail` is false (`MessageView.tsx:76` — only Edit, Bash, Write have detail content), the card:
- Hides the expand triangle via `list-style: 'none'` and sets `cursor: 'default'`
- BUT the `<details>` element is still toggleable by click/tap
- When tapped, it expands to show completely empty space below the summary line
- This creates a confusing "glitch" effect where the card shifts layout with no useful content

### Code location
`frontend/src/components/MessageView.tsx:76-91`

```javascript
const hasDetail = name === 'Edit' || name === 'Bash' || name === 'Write'
// Line 79: ALL tools wrapped in <details> regardless of hasDetail
return (
  <details ...>
    <summary style={{ cursor: hasDetail ? 'pointer' : 'default', 'list-style': hasDetail ? undefined : 'none' }}>
    // Lines 84-89: Only Edit, Bash, Write have content inside <details>
    {name === 'Edit' && <>...</>}
    {name === 'Bash' && ...}
    {name === 'Write' && ...}
  </details>
)
```

### Prevalence
- 153 out of 380 tool_use cards (40.3%) are affected across all 50 served sessions
- Affected tools: Read, Grep, Glob, WebFetch, WebSearch, Skill, Agent, TaskOutput, and any unmapped tool name

### Fix
Replace `<details>` with `<div>` for non-detail tools, or conditionally render:
```javascript
const Wrapper = hasDetail ? 'details' : 'div'
return <Wrapper ...>...</Wrapper>
```

## Screenshots
- read-cards.png — shows Read tool cards that are affected

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (agent-browser)
