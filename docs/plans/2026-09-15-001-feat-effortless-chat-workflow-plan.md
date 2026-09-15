---
title: "feat: Effortless chat to autonomous work"
type: feat
status: completed
date: 2026-09-15
---

# feat: Effortless chat to autonomous work

## Summary

Make New Chat a fast entry to a conversation with a ready team. Quick exchanges stay lightweight; substantial work gets independent review; the same chat can keep working, preserve knowledge, and publish readable progress without user orchestration.

## Requirements

### Start and converse

- R1. A default New Chat claims an unused, prestarted pair without waiting for two cold starts; exhausted or unavailable pools have an honest, usable cold-start path.
- R2. New chats name themselves after the first meaningful request, preserving explicit user titles and never requiring a naming dialog.
- R3. Simple, bounded, low-risk lookups, charts, conversation, and brainstorming do not require reviewer exchanges; substantial deliverables retain agreement and independent artifact review regardless of format.
- R4. One private per-machine configuration selects creator/reviewer engines and models, standby capacity, review policy, and progress cadence.

### Continue and communicate

- R5. Existing conversations can start ongoing work without creating a new chat, through visible controls and agent-interpreted user intent.
- R6. Stop prevents automatic continuation and peer-triggered resurrection without deleting the chat; subsequent human input can resume it. Restart preserves these semantics.
- R7. Ongoing work records durable project checkpoints and wiki-worthy findings, supplying meaningful interim updates to the existing caretaker/marketer pipeline.
- R8. Users can see startup, ongoing work, waiting, stopped, and error states without understanding CR/Ralph internals.
- R11. The creator turns the selected idea from conversation into a scoped objective and next outcome without a setup questionnaire; unrelated ideas are not permission to execute everything.

### Proof and privacy

- R9. Automated lifecycle and browser tests cover cold/warm start, quick work, promotion, progress, stop, and restart; a real-agent synthetic project proves the complete journey.
- R10. Public commits exclude machine configuration, transcripts, private projects, credentials, and deployment evidence.

## Key Technical Decisions

- Keep Sidecar, Ralph, project inbox, and communications runtime: these mechanisms already exist; integrate their lifecycle instead of introducing a second scheduler.
- Allocate standby pairs once with final stable IDs and a clean workspace. Claim atomically; never recycle used conversations or rebind a harness to a different project directory.
- Persist a client creation request ID and normalized request fingerprint with the claimed chat; retries replay that identity after restart, and conflicting reuse returns a conflict.
- Keep standby entries out of chat lists and updates, including native Codex transcript aliases. Persist lifecycle metadata so restart can reconcile ready, starting, and failed entries safely.
- Retain hidden ownership tombstones for failed or retired standby pairs, including native transcript aliases; cleanup must not expose retained setup transcripts.
- Use a bounded pool and bounded refill concurrency. Read-only/test installations can disable prewarming; unavailable engines must not create an endless spawn loop.
- Separate review policy from continuation. Default adaptive review exempts low-risk conversation while retaining agreed criteria for substantial work and existing inbox review gates.
- Add authenticated, creator-only workflow control for agent-interpreted intent rather than matching arbitrary user prose with a permissive regex. UI controls use the same state transition. Start must not introduce a concurrent callback into an active turn.
- Agent start carries the observed human-control generation; Stop invalidates it. Only later human input or a UI action renews authority. Check the generation both at activation and before queued instruction delivery.
- Starting work persists the conversation-derived objective and constraints; it does not implicitly overwrite a shared project inbox objective.
- Publish progress as evidence through the existing communications queue, not a new unedited feed. Preserve deduplication, update comments, and owner routing.
- Progress cadence is a bounded opportunity to report evidence, not a guarantee of achievements or publication. Persist freshness and expose stale/waiting status when there is no edited update.
- Retain existing design tokens and layout. Remove the need to select a special long-running chat type at creation; show a clear ongoing-work control in the conversation.

## Implementation Units

### U1. Machine policy and adaptive review

- Requirements: R3, R4.
- Files: `lib/chat-config.js`, `lib/chat-pair.js`, `server.js`, `.gitignore`, `test/unit/chatConfig.test.js`, `test/unit/chat-pair.test.js`.
- Approach: validated JSON settings outside tracked source, explicit request overrides, persisted engine/model policy; update creator/reviewer instructions to distinguish quick answers from reviewed delivery.
- Patterns: existing injected dependencies in `createChatPair`, metadata-based resume.
- Tests: defaults, invalid values, model persistence, overrides, missing file, adaptive/always review instructions, unchanged substantial-work agreement.
- Verification: both engine selections survive resume; quick work has no required reviewer handoff.

### U2. Ready-pair pool and responsive creation

- Requirements: R1, R2, R8.
- Dependencies: U1.
- Files: `lib/chat-pool.js`, `lib/chat-pair.js`, `server.js`, `frontend/src/App.tsx`, `frontend/src/api.ts`, `test/unit/chatPool.test.js`, `test/unit/chatLifecycleApi.test.js`.
- Approach: reserve/claim/refill lifecycle with hidden standby metadata, health checks, no cross-project reuse, parallel independent readiness work, explicit failures. Preserve API compatibility for existing callers and scoped project-pair creation.
- Tests: concurrent claims are unique; exhausted pool fallback; dead harness; refill failure/backoff; restart reconciliation; Codex alias visibility; no public standby entries; no user content before claim; request timeout/retry behavior.
- Verification: warm claim latency below one second at p95 across twenty isolated trials; measure click-to-editable composer, first-message acceptance, and dispatch separately. Cold startup permits composition and preserves exactly one first message.

### U3. Same-chat ongoing work and progress

- Requirements: R5, R6, R7, R11.
- Dependencies: U1.
- Files: `server.js`, `lib/chat-workflow.js`, `lib/ralph.js`, `lib/chat-pair.js`, `lib/project-comms-runtime.js`, `lib/project-comms-prompts.js`, `bin/feather-workflow.mjs`, `test/unit/chatWorkflow.test.js`, `test/unit/chatLifecycleApi.test.js`, `test/unit/projectCommsRuntime.test.js`.
- Approach: one creator-scoped workflow transition and CLI; persist objective/checkpoints; deliver updated instructions to already-running conversations; attach recurring progress evidence to meaningful checkpoints and surface long silence honestly without invented achievements.
- Tests: ordinary chat promotion with conversation-derived objective; reviewer/cross-session denial; repeated start idempotence; start while active has no duplicate callback; stop cancels pending work; peer traffic cannot resume; human input can; restart; progress deduplication and ownership; stale progress and suppressed publication.
- Verification: one conversation progresses through talk, reviewed work, continued work, stop, restart, and resume with durable evidence.

### U4. Coherent conversation controls

- Requirements: R1, R5, R8.
- Dependencies: U2, U3.
- Files: `frontend/src/App.tsx`, `frontend/src/api.ts`, `frontend/src/style.css`, relevant existing style files, `test/e2e/chat-workflow.spec.js`.
- Approach: use machine default on New Chat; preserve optional engine choices; replace special Ralph creation with in-chat Keep working/Stop controls and readable status. Keep naming automatic.
- Tests: keyboard and mobile usability; startup errors retain draft; same-chat promotion; Stop/Resume; default engine request omitted; standby sessions hidden.
- Verification: browser journey and screenshots at desktop/mobile widths, no leaked setup prompts or review transcript noise.

### U5. End-to-end proof and release

- Requirements: R9, R10; verify R1–R8.
- Dependencies: U1–U4.
- Files: `test/e2e/chat-workflow.spec.js`, `test/unit/chatLifecycleApi.test.js`, `docs/chat-workflow.md`.
- Approach: full regression suite, independent review, browser recording/screenshots, and live synthetic-data project. Publish only portable documentation and sanitized tests; keep runtime receipts local.
- Tests: quick synthetic holdings lookup and chart with zero reviewer exchanges; substantial analysis with agreed criteria and independent verdict; continued useful work and interim human-readable update; stop/restart integrity.
- Verification: deploy the audited revision, verify live health and new-chat flow, and report measured results rather than implying arbitrary hundredfold capacity.

## Assumptions and Boundaries

Default standby capacity is small and configurable; prewarming consumes processes, not speculative task execution. Large bursts use explicit startup states rather than pretending unlimited warm capacity. No new financial integrations, arbitrary agent architecture builder, or global redesign is included. Existing user chats and project files are preserved. Production release follows the existing guarded release path; public push must retain the sanitized ancestry.

## Risks and Operational Notes

Terminal settled is not proof a model answered: expose readiness conservatively and verify actual prompt delivery in live acceptance. Codex transcript IDs differ from stable chat IDs and must be reconciled before visibility. Existing active sessions retain old prompts until refreshed, so workflow activation must carry the new policy. Pair setup failures retain produced files while cleaning only owned empty state. Progress publication remains asynchronous; expose current status separately from edited Updates.
