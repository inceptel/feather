---
status: complete
execution: code
---
# Project communications

Approved outcome: CR results pass through caretaker and marketer before reaching Updates. Comments reach replyguy, which answers or delegates a task to the owning CR and returns with its result. No Rooms restoration, no unrelated schedules resumed.

## U1 — Durable communication primitives
Files: new lib/project-comms.js, lib/project-comms-prompts.js, test/unit/project-comms.test.js.
Store durable source cursors, coalesced per-project jobs, explicit role completion, leased dispatch/retry, curated publications, comments and task follow-up. Agent prompts own editorial judgment, evidence selection and writing; code owns identity, validation, persistence and routing. No model API credentials: use existing Feather sessions. Failed/stale callbacks cannot publish. Never mark jobs done from transcript heuristics. Retry must not duplicate a publication or delegated task.
Tests: restart, duplicate sources, role transitions, token/session mismatch, retry and stale callback, suppression, comments, delegated results.

## U2 — Runtime integration
Files: server.js, new lib/project-comms-runtime.js if useful, backend integration tests.
Discover CR results and shared wiki changes, capture evidence and project identity, invoke bounded caretaker/marketer/replyguy sessions, authenticate callback with existing session capability. Curated cards replace raw CR/wiki projection in Updates; retain raw events in activity. Legacy published cards remain. Route project comments without requiring Room identity. Expose queue status/pause/retry to user and agents. Preserve read-only mode, stopped legacy helpers, unrelated CRs and authentication.
Tests: real persistence + API chain, source→caretaker→marketer→feed and comment→replyguy→CR task→follow-up reply; no external agent mocks for the final live acceptance.

## U3 — Usable Updates and inspectable automation
Files: frontend/src/components/SuperFeed.tsx, frontend/src/components/SchedulerView.tsx, frontend/src/api.ts, related frontend CSS and test/e2e/project-communications.spec.js.
Project cards expose comments and replies. Queue status, running session links and pause/resume/retry visible under Autopilot. Preserve current navigation, other filters and legacy comment behavior. Accessible keyboard/mobile controls.
Tests: project comments and reply refresh, failure/draft preservation, automation status/actions, mobile viewport.

## U4 — Verify, deploy, demonstrate
Full relevant unit/browser tests, independent review, inspect screenshots; guarded release archive/canary/promotion. Run real agents on Spread Rush evidence to publish an edited Update. Submit a clearly identified acceptance-test comment with a bounded project documentation task; verify replyguy delegates, CR completes, and a result returns under the same comment. No manual stand-in for role output. Keep truthful receipts; only claim success after the live chain completes.

## Completion receipt

Deployed application commit 7b270df, production version 2026-09-15T14:18:33Z. Final backend run: 474 pass. Browser canary: 26 pass, including eight communication tests. Live frontend/backend version, routes, screenshots, and transcript preservation verified.

Real acceptance completed 2026-09-15T14:29:38Z: edited Spread Rush publication `pub-market-f99e9933-bb1e-4ad3-b3c9-57f12a0c4aa6`; comment `4c068240-674b-4b1a-a546-47778d3a671c`; delegated task `reply-4c068240-674b-4b1a-a546-47778d3a671c` completed with reviewer PASS; replyguy returned its result under the original comment. The pair corrected content and link issues, preserved concurrent wiki changes, and left game files unchanged. The request survived a production restart.

The live test exposed stale direct-feed instructions. These were corrected permanently in generated/resumed CR prompts and comment delivery; both running peers received an explicitly labeled migration notice. The first editor card was verbose, so the final release tightens future editor instructions. Reply verbosity and high-volume queue performance remain tuning opportunities, not claims proved by this one acceptance.

Evidence: `/home/user/.feather/deploy-receipts/project-comms-sdit44Cg/live-acceptance.json` and `/home/user/.feather/deploy-receipts/project-comms-contract-7lkyFvGr/`. No parent-authored stand-in was used for any role result.
