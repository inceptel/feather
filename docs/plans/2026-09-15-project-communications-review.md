# Project communications verification

Review scope: changes after 96886b2, including new project-comms modules.

Independent review covered correctness, security, reliability, API contracts, agent-native prompts, project standards, testing, maintainability, performance, and frontend races. Simplification review covered reuse, quality, and efficiency. Installed persona-specific files were unavailable; reviewers used the skill's focus catalog. No docs/solutions learning directory exists.

Applied findings: isolate failed delegations; expose stalled/blocked replies; preserve read-only routes; avoid idle feed rebuilds and repeated source-state reads; guard Stop at the send lock and submission; avoid duplicate wiki acknowledgment; retain unfinished jobs beyond 100 entries; isolate oversized sources; expose runtime errors; avoid overlapping status polls.

Verification includes durable store/runtime tests, authenticated HTTP publication/comment callbacks, guarded-send cancellation tests, and desktop/mobile browser comment and helper-control tests. Live agent acceptance is tracked in the implementation plan and deployment receipt, not inferred from mocked transports.

Residual limits: two simultaneous helper jobs, serialized per project; fresh subscription-backed sessions per job; bounded JSON state requires eventual archival at the explicit capacity limit. Source discovery filesystem errors are surfaced and retried. Exactly-once external CLI execution is not guaranteed across a crash between submission and receipt persistence; inbox task IDs and publication callbacks are idempotent.

Concurrency and authorization changes received independent diff inspection as well as tests; green tests alone are not treated as proof.
