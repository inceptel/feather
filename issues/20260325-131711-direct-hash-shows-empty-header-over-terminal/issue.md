# Bug: Direct hash view shows empty-state header over terminal content

## Status
new

## Severity
high

## Steps to reproduce
1. Open `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf` on mobile (`390x844`).
2. Wait for Feather to finish loading the direct session URL.
3. Observe the header and the body content.

## Expected behavior
The page should resolve into one coherent state: either load the targeted session with its real title, or stay on the empty `Select a session` state with no session transcript visible.

## Actual behavior
Feather renders a split-brain screen. The top bar still says `Select a session`, but the body below shows a live terminal transcript and terminal footer from a session. The UI simultaneously presents "no session selected" and "session is open".

## Screenshots
- direct-session-current.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- URL: `http://localhost:3304/#370e2f60-1399-4ebf-a182-7a8ba6c59ccf`
