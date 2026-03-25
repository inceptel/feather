# Bug: Raw `<persisted-output>` tags render as visible message text

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`) in Chromium.
2. Land in a chat transcript that contains persisted output content, or open any session with a previously persisted output summary.
3. Inspect the visible assistant/user message bubble near the bottom of the transcript.

## Expected behavior
Persisted output markup should be parsed or stripped before rendering, so users only see the intended message text.

## Actual behavior
Feather renders the literal `<persisted-output>` tag text inside the chat bubble, exposing internal markup directly in the conversation UI.

## Screenshots
- landing.png
- full-page.png

## Notes
- DOM verification on `2026-03-25T08:24:02Z` returned `document.body.innerText.includes("<persisted-output>") === true`.
- During repro, the page had already redirected to `http://localhost:3301/#a37e9d44-c50a-49be-8dac-1e7f62480bfc`, but the raw tag was still visible in the rendered transcript on the worker-4 entry flow.

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
