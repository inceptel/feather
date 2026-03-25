# Bug: Header still says "Select a session" while a chat transcript is open

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Wait for Feather to finish loading the initial session view.
3. Observe the header text and the main pane contents.

## Expected behavior
When a transcript and composer are visible, the header should identify the active session, or Feather should remain in the true empty state with no loaded transcript.

## Actual behavior
Feather shows a full chat transcript with Chat/Terminal tabs and the message composer, but the header still says `Select a session`, which is the empty-state label. In this repro the page also ended up at `http://localhost:3301/#549bddbd-df9b-46a6-9cc4-13712ad51ad6`, so the UI provides no reliable active-session context.

## Evidence
- `agent-browser eval` returned `headerText: "Select a session"`, `hasSend: true`, `composerPlaceholder: "Send a message..."`, and `href: "http://localhost:3301/#549bddbd-df9b-46a6-9cc4-13712ad51ad6"` while the transcript content was visible.

## Screenshots
- current-state2.png
- current-state-full.png

## Environment
- Viewport: `390x844` (mobile)
- Browser: Chromium (`agent-browser`)
