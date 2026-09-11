# Chat-first Feather

Implemented on `feat/pinned-chats`. Release receipts record deployment state.

- Home is Chats, with durable pins and an archive. Existing Rooms supply initial
  pins; their files, APIs and deep links remain intact for compatibility.
- New chat creates a Creator–Reviewer pair and a unique readable folder under
  `~/projects` (`FEATHER_PROJECTS_DIR` overrides it). The Reviewer is a sidecar,
  not a second chat in ordinary discovery. Pair registration and role prompts
  persist independently of the tmux processes.
- Wiki browses `~/wiki` (`FEATHER_WIKI_DIR`) and existing Room wiki collections.
- Updates preserves the existing feed, includes shared wiki edit notifications,
  and reads explicit summaries from each Creator's workspace `updates.<creatorSessionId>.json`.
  This is an array of `{id, title, summary, occurredAt}`. The role contract asks
  the Creator to publish only reviewed, material results. Review approval is a
  prompt-level contract, not a server-enforced gate.
- Autopilot shows scheduled work and Ralph chats, including those outside the
  recent-session window or with no readable transcript yet.
- Stop disables automatic continuation and preserves the conversation. A new
  human message re-enables Ralph. Peer traffic, stale callbacks and retries of
  an already-delivered human message do not re-enable a stopped loop.
- The Creator alone drives Ralph. `RALPH_WAITING:` waits for the Reviewer without
  scheduling another automatic continuation; incoming peer feedback starts the
  next turn. Greetings and acknowledgments do not require review.

## Project continuity

- A Creator's menu offers **New chat in this project** and **Rename project folder**.
  Multiple pairs share files, but retain their own identities and update files.
- Renames keep a compatibility symlink at the old path and retain each harness's
  original launch path. Session JSON stays in its existing harness directory.
  Do not remove compatibility links while those chats remain in use.
- A durable rename intent is recovered at startup if interruption occurs between
  moving the folder, making its compatibility link and updating metadata.
- Codex CR sessions carry unique developer identity markers; rollout adoption
  must match that identity as well as the workspace, even for same-harness pairs.

## Compatibility and limits

- Existing scheduled work still uses the legacy scheduler APIs; the tab is now
  Autopilot. This change does not add a new schedule-authoring form.
- Legacy Room deep links/APIs remain for existing history. They are no longer
  the primary home or the required way to start work.
- Approval is prompt-level, not a cryptographically enforced review gate.
- Automated restart tests cover the server, metadata, compatibility paths and
  live filesystem processes. Actual model-service availability is a separate
  operational smoke check.
- A real Claude continuity smoke test also passed: a fresh process resumed the
  same session and recalled its earlier phrase after its project folder was
  renamed through the production rename helper.

## Verification

Run `node --test --test-concurrency=1 test/unit/*.test.js` with isolated state,
and `npm run build` in `frontend`. The focused `pinned-chats.spec.js` browser
suite uses mocked API data at desktop and phone widths; it is not a live
agent acceptance test.

## Post-Deploy Monitoring & Validation

Owner: deploying agent. Verify the exact staged version from `/api/health` and
the frontend build; navigate Chats, Wiki, Updates and Autopilot. Watch
`/tmp/feather-prod.log` for `[chat-pair] creation failed`, `Autopilot run stopped`,
uncaught exceptions and repeated callback delivery errors for at least two
minutes after promotion. Expected: healthy listener, stable version, existing
pins/history visible, no spontaneous new work from stopped chats. Roll back via
`bin/refeather rollback` to the recorded prior release on health/version mismatch,
new persistent 5xx responses, or unexpected background continuation. State schemas
remain additive; rollback preserves project compatibility links and chat files.
