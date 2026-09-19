# From conversation to ongoing work

Open **New Chat** and describe your idea. There is no naming form: the chat gives itself a short title after the first meaningful request, while preserving a title you choose yourself. You can paste rough ideas, ask questions, or make a simple chart before deciding what to build.

Under the default adaptive review policy, bounded, low-risk questions and conversation do not require a reviewer exchange. Substantial deliverables still need agreed criteria and independent review of the actual result. Output format alone does not decide: a simple chart can be quick work, while an analysis supported by charts may need review.

## Keep working in the same chat

Once the direction is clear, say “go” or “keep working,” or use **Keep working** in the conversation. The creator carries the selected objective and constraints forward in that chat. Other ideas mentioned earlier are not automatically additional assignments. A shared project's existing assignment is not silently replaced.

Ongoing work continues through useful steps and verification. It may wait for review or a dependency, ask for a concrete human decision, or finish when the objective and justified follow-through are complete. It should not invent chores to remain busy.

**Stop** disables automatic continuation without deleting the conversation or its evidence. Peer feedback cannot restart a stopped chat. A new human instruction can resume it; **Resume** provides an explicit control. Stop and saved progress survive a server restart. A transport or startup error is shown as an error, not completion.

## Progress, wiki, and Updates

The conversation's progress records describe the current objective, phase, recent evidence, next action, and when the record was updated. A stale timestamp means the record is old; it is not evidence that new work succeeded.

Material interim evidence can go to the existing communications team. The caretaker evaluates it and maintains useful wiki knowledge; the marketer edits selected findings into readable **Updates**. These publications are asynchronous and optional. Editors may combine or suppress evidence, and progress does not become independently reviewed completion merely because it appears in an update.

The configured interval limits opportunities to submit material progress for publication. It does not promise an achievement or a published update every interval. Quiet investigation and waiting states should remain honest. The chat's progress is available separately from edited Updates.

## Machine configuration

Store local policy in `~/.feather/chat-config.json`, or set `FEATHER_CHAT_CONFIG` to a different JSON file. Keep machine configuration out of public commits. A missing file uses these defaults:

```json
{
  "creator": { "agent": "claude", "model": "" },
  "reviewer": { "agent": "codex", "model": "" },
  "standbyPairs": 1,
  "reviewPolicy": "adaptive",
  "progressIntervalMinutes": 15
}
```

- `creator` and `reviewer` each accept `agent` (`claude`, `codex`, or `omp`) and `model`. An empty model uses the engine's default. A named model must be available to that engine.
- `standbyPairs` is an integer from `0` to `4`. Zero disables prewarming.
- `reviewPolicy` is `adaptive` or `always`. `always` retains reviewer agreement and review for small tasks as well; greetings and acknowledgments need no review.
- `progressIntervalMinutes` is an integer from `1` to `1440`.

`FEATHER_CHAT_POOL_SIZE` overrides `standbyPairs` with an integer from `0` to `4`. Restart the server after changing its configuration. Explicit chat creation options can override engine, model, review policy, and progress interval for that chat. Saved engine and model choices follow the chat on resume.

## Startup and capacity

The small standby pool keeps unused creator/reviewer pairs ready for default New Chat requests. Claiming a pair preserves its stable identities and clean workspace; used conversations are never recycled for someone else's task. Standby setup stays out of normal chat lists and Updates.

If the pool is empty, an engine is unavailable, or custom options require a fresh pair, startup can take longer. You can compose while startup is pending; the first message is retained until it can be sent. Startup failures should remain visible and preserve the draft.

Prewarming consumes local processes and engine resources. It reduces cold-start waits; it is not a claim of unlimited capacity or a hundredfold increase in useful work. Review, verification, and available engines still determine throughput.

After three consecutive prewarming failures, automatic retries pause. Correct the engine login or configuration and restart Feather to retry; explicit New Chat requests still have the normal cold-start path. A restart during scope selection cancels that pending activation rather than silently starting uncertain work. The conversation remains available.

## Agent workflow control

Inside a creator session, the supplied `feather-workflow.mjs` CLI supports `read`, `start`, `progress`, and `stop`. It uses the session's bridge capability; reviewers cannot control another chat's workflow.

Read the control generation for the current human instruction and pass that observed generation with `start` and `progress`. Stop or newer human input invalidates old generations. The CLI never fetches a fresh generation to make an old start request succeed. Progress checkpoints can include evidence and request editorial consideration; a checkpoint alone never bypasses substantial-work review.

## Release checks

After deployment, verify health and build versions, an editable New Chat, a warm claim, and the chat/Updates/wiki routes. Watch server logs for `[chat-pair]`, `[chat-pool]`, `[workflow]`, and `[project-comms]` failures during startup and the first useful task. A stopped chat must remain stopped after a restart; an offline completion must not be replayed. Roll back if chat creation, ordinary message delivery, Stop, or saved-state recovery regresses. Keep recordings, transcripts, machine policy, and deployment receipts private.
