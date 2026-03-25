# Bug: Chat and Terminal view switchers lack tab semantics

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#16eab499-9569-4fd5-940b-4490fb6fbc45` on mobile (`390x844`).
2. Inspect the `Chat` and `Terminal` view switchers in the session header with the accessibility tree or DOM.
3. Switch between `Chat` and `Terminal`.

## Expected behavior
The view switchers should be exposed as a tab interface, with a tablist, selected state, and relationships to their associated panels so screen reader users can understand which view is active.

## Actual behavior
Feather exposes `Chat` and `Terminal` as plain buttons. The accessibility snapshot reports only `button "Chat"` and `button "Terminal"`, and DOM inspection shows both controls have no `role`, `aria-selected`, or `aria-controls` attributes.

## Evidence
- Accessibility snapshot on the session screen:
  - `button "Chat"`
  - `button "Terminal"`
- DOM inspection returned:
  - `{"text":"Chat","role":null,"ariaSelected":null,"ariaControls":null}`
  - `{"text":"Terminal","role":null,"ariaSelected":null,"ariaControls":null}`

## Screenshots
- hash-session-current.png
- terminal-current.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
