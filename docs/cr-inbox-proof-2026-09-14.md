# CR inbox acceptance: passed

On 2026-09-14, two real CR pairs completed a shared tic-tac-toe project in an
isolated Feather instance. Creators ran Claude and Reviewers ran Codex through
the existing subscription-backed harnesses. The run lasted approximately
24 minutes, followed by an independent browser acceptance pass.

## Result

- Six human-seeded tasks completed: playable board, win/draw rules, New game,
  scoreboard, responsive layout, keyboard controls and live status.
- One agent-generated improvement completed: dynamic accessible names showing
  each cell's empty/X/O state. It was not specified in the initial task list.
- Both pairs contributed; every task had one claim and an independent
  Reviewer agreement before submission. Final PASS records matched exact
  commits reachable from the integrated main branch.
- The Reviewer rejected the seeded missing anti-diagonal win detection for
  both X and O. The Creator fixed it and obtained a new PASS.
- Review also caught a genuine unseeded failure: score labels smaller than
  the agreed minimum. That was corrected before approval.
- Server restart preserved ownership. Stop prevented automatic continuation;
  ordinary human chat input resumed it.
- All seven completions appeared in Updates. Every completion cited wiki
  knowledge. Sidecar transcripts contain wiki draft reviews and requested
  factual corrections, which the Creators applied before publication.
- The orchestrator did not edit the website or provide unplanned continuation
  messages. Initial instructions and the planned Stop/resume intervention
  were the only human-role inputs.

## Independent verification

The final website passed 21 Chromium checks, including all eight winning
lines for both players, occupied-square protection, draw and cumulative
scores, post-game lockout, keyboard controls, status semantics, and layouts
at 390px and 1280px. Screenshots were retained and the mobile result inspected.
This verifies DOM accessibility semantics, not audible screen-reader output.

Feather verification: 449 backend tests and seven inbox UI tests passed;
the frontend production build passed. Existing repository-wide TypeScript
errors remain outside the new inbox component.

## Evidence and reproduction

Retained local run: `/tmp/feather-cr-proof-9miBQB`.

- `receipt.json`: original live lifecycle checks.
- `supplemental-receipt.json`: independent final verification, all checks true.
- `supplemental-browser/report.json`: 21 passing browser scenarios.
- `state/project-inboxes/5809549a-b8dc-4de2-9a82-52500116ca49.json`: task and review history.
- `home/.feather/sidecars/*/chat.jsonl`: actual Creator–Reviewer exchanges.
- `home/wiki/`: five topic pages cited by all seven tasks.
- `home/projects/tic-tac-toe-pair-a/`: integrated website and both pairs' evidence.
- Final website commit: `930e3773848a6b97877277f4208321987e75916c`.

The test's copied subscription credentials were removed on teardown.
Production Feather was not restarted or deployed by this proof.
Temporary evidence may be removed by host cleanup; this document preserves
the result but is not a replacement for the detailed receipts.

To repeat the real-agent test:

```sh
node test/live/cr-inbox-proof.mjs --run
```

To recheck the retained run:

```sh
node test/live/verify-cr-inbox-proof.mjs /tmp/feather-cr-proof-9miBQB
```

This proves the two-pair workflow, not a hundredfold load increase. The
inbox UI now polls lightweight summaries and retrieves reviews on demand;
large-scale concurrency and long-lived history still need measured load tests.
