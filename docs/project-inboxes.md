# Shared project inboxes

A project can have several Creator–Reviewer (CR) pairs. They share one inbox,
but each task has one owning pair. The Creator does the work; its Reviewer
agrees the success criteria before implementation and independently checks
the submitted revision. A rejection goes back to the Creator for correction.

## Use it

1. Create a CR chat, choosing Ralph for automatic continuation. Additional
   pairs join the same project through the existing project selection.
2. In the Ralph tab, open **Project direction**, save a standing objective,
   and add tasks. Allow follow-up ideas only if you want agents to propose them.
3. Expand a task to see its criteria, latest review and result. **Open pair**
   takes you to the conversation, where you can interject normally.

The lifecycle is `queued → agreeing → building → reviewing → approved → done`.
REVISE returns to building. Blocked tasks show a reason; Unblock requires fresh
agreement. Dependent tasks become claimable only after their prerequisites
are done. A pair resumes its existing unfinished task rather than claiming
another one. Completed work appears in Updates without a separate posting step.

Stop prevents new automatic Ralph and sidecar-triggered turns; it does not
delete the chat or kill an already-running turn. Ordinary chat input resumes
the Ralph. Inbox notifications do not override an explicit Stop. Waiting pairs
wake when new eligible work arrives, including work that arrived during their
previous turn. Scheduled callbacks and task ownership survive server restart.

## Agent interface

The system prompt supplies the absolute path to `bin/feather-inbox.mjs`.
It uses the session's bridge capability and exact Feather instance; there is
no fallback discovery that could accidentally write to another instance.

Commands accept a JSON argument, `--file PATH`, or `--stdin`:

```sh
node /path/to/feather/bin/feather-inbox.mjs read
node /path/to/feather/bin/feather-inbox.mjs claim '{}'
node /path/to/feather/bin/feather-inbox.mjs propose '{"taskId":"example","criteria":["A concrete, observable success check"]}'
```

The Reviewer calls `agree` and `review` itself. The Creator calls `submit`,
`complete`, `block`, `unblock`, and (when allowed) `add`. See the CR system
prompt for the full payloads. Review and completion must reference the exact
submitted revision. Submitting a new integrated revision invalidates an older
approval. Repeated identical transitions are safe to retry.

Human endpoints are the lightweight `GET /api/project-inboxes`,
`GET /api/chats/:id/inbox`, `GET /api/chats/:id/inbox/tasks/:taskId`, and POSTs beneath the inbox for `config`, `tasks`,
and `tasks/:taskId/unblock`. Agents use
`POST /api/internal/sessions/:id/inbox` with `X-Feather-Bridge-Token`.
Agent role and project identity come from server metadata, never request fields.

## Persistence and boundaries

Inbox state lives under the instance state root in
`project-inboxes/<projectId>.json`, using Feather's atomic JSON writer and
last-good recovery. One Feather process owns writes to an instance. Do not
run multiple writer processes against the same state directory. Documents
are bounded to 1,000 tasks and the latest 1,000 events per task; this is a
small local work queue, not an unbounded archive.

For parallel code work, each pair uses its own git worktree and serializes
integration into the project branch. The Reviewer checks the integrated
revision. Wiki drafts are reviewed in the sidecar conversation before the
Creator publishes them; separate topic pages avoid competing writers.

The server enforces ownership, roles and revision-string matching. It does
not prove that tests were honest, hash arbitrary artifacts, or sandbox
same-host agents from each other's files. Wiki approval is recorded in the
conversation, not a server-enforced content hash. The live acceptance test
therefore independently checks the integrated website and retained evidence.

## Acceptance test

`node test/live/cr-inbox-proof.mjs --run` explicitly launches two real CR
pairs (four subscription-backed sessions) in an isolated Feather instance.
It builds an HTML tic-tac-toe site from six tasks and lets the pairs choose
one useful follow-up. A deliberately missing anti-diagonal win rule must be
rejected and corrected. The test restarts that instance mid-work, exercises
Stop and normal-message resume, and verifies ownership, independent reviews,
wiki knowledge, Updates and the final website in Chromium.

The runner prints a private temporary evidence directory. It never deploys
the website or changes production Feather. On exit it stops only its own
sessions and removes its temporary copies of subscription credentials.
The website, inbox history, reviews and browser evidence remain for inspection.
