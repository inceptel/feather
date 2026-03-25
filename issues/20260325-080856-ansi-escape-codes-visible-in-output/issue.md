# Bug: Raw ANSI escape codes are visible in OUTPUT cards

## Status
new

## Severity
medium

## Steps to reproduce
1. Open `http://localhost:3304/` on mobile (`390x844`).
2. Open the session drawer and select the `WORKER_NUM=1 ... PORT=3301` session that is visible near the top.
3. Look at the first visible `OUTPUT` card in the transcript.

## Expected behavior
Tool output should render plain text or styled terminal output without exposing raw ANSI control sequences.

## Actual behavior
The chat transcript renders literal ANSI escape codes such as `\u001b[32m` and `\u001b[0m` directly inside the `OUTPUT` card, so users see terminal control bytes instead of clean output.

## Screenshots
- ansi-escape-visible.png

## Environment
- Viewport: 390x844 (mobile)
- Browser: Chromium (`agent-browser`)
- URL after selection: `http://localhost:3304/#a37e9d44-c50a-49be-8dac-1e7f62480bfc`
