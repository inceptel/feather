# Bug: Loaded chat screen lacks heading semantics

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for the chat transcript to render.
3. Inspect the rendered screen semantics.

## Expected behavior
The loaded chat view should expose a heading for the current screen or conversation so assistive tech has a navigable page title.

## Actual behavior
The chat screen renders visible header text (`Select a session`) but exposes no heading elements or `role="heading"` nodes at all (`headingCount: 0`), leaving the loaded conversation without a semantic heading.

## Screenshots
- chat-screen.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
