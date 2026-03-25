# Bug: No responsive layout for desktop — messages span 1048px, sidebar hidden behind hamburger

## Status
new

## Severity
medium

## Steps to reproduce
1. Open http://localhost:3301/ at desktop viewport (1280x800)
2. Open the sidebar via hamburger menu, select any session
3. Observe message bubble widths and sidebar behavior

## Expected behavior
On a 1280px desktop viewport:
- Sidebar should be persistent (always visible, ~250-300px), not hidden behind hamburger
- Chat messages should have an absolute max-width cap (e.g., 700-800px) for comfortable reading
- The conversation column should be centered within the remaining space
- Standard chat app pattern: side-by-side sidebar + constrained chat area

## Actual behavior
The same mobile-first layout is used at all viewport sizes with no desktop breakpoint:
- **Sidebar**: Hidden behind hamburger menu overlay at 1280px, identical to 390px mobile behavior. User must click hamburger → select session → sidebar auto-closes, same workflow as mobile.
- **Message widths**: Bubbles use `max-width: 85%` with no absolute cap. At 1280px, this means:
  - User messages: 1048px wide (85% of ~1232px content area)
  - OUTPUT cards: up to 1048px wide
  - Text lines span 150+ characters — far exceeding the 45-75 char optimal reading width
- **Sidebar overlay on desktop**: When opened, the 300px sidebar overlays content instead of pushing it or coexisting, wasting ~980px of available space.
- **No CSS media query breakpoint** exists for viewports wider than ~768px.

## Technical details
From DOM inspection at 1280x800:
```
Message max-width: 85% (percentage only, no absolute cap)
User message actual width: 1048px
OUTPUT card actual width: 1019-1048px
Sidebar: Fixed 300px overlay, toggled by hamburger
```

## Impact
- Every desktop user sees this — affects 100% of sessions at wide viewports
- Reading 1000px+ wide text blocks is straining (double the recommended line length)
- Session navigation requires extra clicks (hamburger → select → auto-close) vs persistent sidebar
- The app appears mobile-only when viewed on desktop

## Suggested fix
Add a CSS media query at ~768px breakpoint:
1. Make sidebar persistent (flex sidebar + main content)
2. Add `max-width: min(85%, 700px)` to message bubbles
3. Center the chat column within the remaining space

## Screenshots
- desktop-1280-messages.png — Full 1280px view showing messages spanning near-full width
- desktop-sidebar-overlay.png — Sidebar as overlay on desktop (same as mobile)
- desktop-top-scrolled.png — User message and tool cards at top of conversation

## Environment
- Viewport: 1280x800 (desktop)
- Browser: Chromium (agent-browser)
- Confirmed via JS: window.innerWidth=1280, window.innerHeight=800
