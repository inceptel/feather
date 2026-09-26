# Guarded Feather release workflow

`bin/refeather` replaces in-place checkout rebases with immutable release
staging and an explicit sole-writer promotion. It never fetches, rebases,
resets, merges, or edits the source worktree.

## Paths and runtime identity

Choose these once per host and keep them in the operator receipt:

```bash
export REFEATHER_RELEASES_DIR=/opt/feather/releases
export REFEATHER_CURRENT_LINK=/opt/feather/current
export REFEATHER_JOURNAL_DIR=/var/lib/feather/refeather
export REFEATHER_LOCK_FILE=/var/lock/feather-refeather.lock
# Non-root installs may omit both: refeather falls back to ~/.feather/refeather and ~/.feather/refeather.lock when /var/lib/feather and /var/lock are not writable.
export REFEATHER_SUPERVISOR_PROGRAM=feather-prod
export REFEATHER_SUPERVISOR_SOCKET=unix:///run/supervisor.sock
export REFEATHER_HEALTH_URL=http://127.0.0.1:8123/feather2/api/health
```

The Supervisor program must execute the stable current link, use the external
`FEATHER_STATE_DIR`, and include the installed CLI directory on `PATH`. The
program, socket, and mounted health URL are mandatory inputs; `refeather` does
not infer them from a checkout name or port.

## 1. Stage without changing production

```bash
release=$(bin/refeather stage \
  --source /srv/feather/source \
  --releases-dir "$REFEATHER_RELEASES_DIR")
```

Staging verifies dependencies, disk projection, Git conflicts, tracked and
untracked changes, and commits ahead of the configured upstream. It archives
HEAD into `<releases>/<full-commit>`, builds inside that temporary tree, writes
`.refeather-release.json`, removes write permission, and atomically publishes
the release directory. It never changes `current` or invokes Supervisor.

Use `--check-port <canary-port>` when reserving a canary listener. A collision
stops staging.

### Personalized or unpushed source

Unsafe source proceeds only with `--archive-receipt FILE`. Receipt schema 1
must name the exact `sourceCommit` and four independently hash-verified files:

```json
{
  "schema": 1,
  "sourceCommit": "full Git commit",
  "artifacts": {
    "refs": { "path": "refs.bundle", "sha256": "..." },
    "binaryDiff": { "path": "worktree.diff", "sha256": "..." },
    "untracked": { "path": "untracked.tar", "sha256": "..." },
    "mutableState": { "path": "state.tar", "sha256": "..." }
  }
}
```

Paths may be relative to the receipt. An unresolved Git conflict always stops;
an archive receipt cannot make a conflicted index deployable.

## 2. Install and preflight capabilities

```bash
bin/refeather install-capabilities \
  --release "$release" \
  --target-root "$REFEATHER_CURRENT_LINK"
```

This installs Feather and Sidecar into `~/.claude/skills` and `~/.codex/skills`,
Council plus Feather protocol tools into `~/.omp/agent`, and `room`, `sidecar`,
`refeather`, plus `feather-instance` into `~/.local/bin`. Existing correct links
are left alone. A file or foreign link is copied into a conflict evidence
directory and causes a full preflight abort; nothing is overwritten. Managed
links that still point at an older immutable release also appear as conflicts:
pre-remove only the exact stale links named by the failed preflight, retaining
the conflict evidence. Promotion runs the same preflight by default before
stopping the service.

Set `FEATHER_URL` to the exact public or loopback mounted base used by the
instance. CLI fallback probes `FEATHER_PORT` (or legacy `PORT` when
`FEATHER_PORT` is unset), 4870, and 3300 and refuses zero or multiple
Feather-shaped responses. This discovery fallback is not deploy targeting. On
the primary host, public production is Supervisor program `feather` on `:3300`;
never deploy or restart the hub-managed `feather-live` duplicate on `:4870`.

## 3. Promote as the sole writer

Run any canary/backup gate through `--pre-promote-check` before quiescing:

The canary gate must own its process lifecycle. Record the canary PID, install a
termination trap, and verify that both the recorded process and listener are
gone before promotion. Stopping an SSH or hub session is not cleanup: detached
read-only canaries have survived it. After an interrupted gate, identify the
canary by its recorded PID and command line before terminating it; never kill an
unverified PID.

```bash
sudo -E bin/refeather promote \
  --release "$release" \
  --current-link "$REFEATHER_CURRENT_LINK" \
  --program "$REFEATHER_SUPERVISOR_PROGRAM" \
  --supervisor-socket "$REFEATHER_SUPERVISOR_SOCKET" \
  --health-url "$REFEATHER_HEALTH_URL" \
  --pre-promote-check '/path/to/canary-gate'
```

Promotion verifies the staged release content hash immediately before mutation,
takes the host lock, writes `active.json` and an fsynced JSONL phase journal,
stops the named program, atomically replaces `current`, starts the same program,
and requires `/api/health.version` to equal the staged manifest. Supervisor
operations have a finite timeout (`REFEATHER_SUPERVISOR_TIMEOUT`, 15 seconds by
default). An ordinary failure is recovered only after the prior link, prior
program restart, listener, and exact prior health version are all verified.
Record the completed state JSON and journal with the migration receipt.

## Recovery and rollback

After host loss or an untrappable process termination:

```bash
sudo -E bin/refeather recover
```

`recover` owns the same lock. A transaction interrupted before service
mutation is finalized as a no-op; one interrupted from stop through health
verification restores and verifies the recorded prior release; an already
promoted transaction is only finalized.

To deliberately return to a retained compatible release:

```bash
sudo -E bin/refeather rollback \
  --release /opt/feather/releases/<prior-commit> \
  --current-link "$REFEATHER_CURRENT_LINK" \
  --program "$REFEATHER_SUPERVISOR_PROGRAM" \
  --supervisor-socket "$REFEATHER_SUPERVISOR_SOCKET" \
  --health-url "$REFEATHER_HEALTH_URL"
```

Rollback uses the same lock, phase journal, atomic link, health-version gate,
and failure restoration. It does not restore an older state snapshot; state
schema compatibility must already have passed the separate downgrade gate.

If restoration cannot be verified, the journal records `rollback-failed` and
retains `active.json`. Repair the underlying Supervisor or listener issue and
rerun `refeather recover`; do not remove the active transaction by hand.

## Release retention

Every stage leaves an immutable release (~200 MB). After each verified promote
or rollback, refeather prunes old releases automatically. It always keeps:

- the current release and the one it replaced (the rollback target);
- the `REFEATHER_KEEP_RELEASES` newest (default 10; `0` disables pruning);
- any release named by a running process's argv or cwd;
- any release named in a file under `REFEATHER_REFERENCE_DIR` (default
  `~/.feather/session-system-prompts`) changed in the last 14 days. Session
  prompts embed release CLI paths, so live agents keep their release.

A prune failure is reported but never undoes a promotion. To preview or run it
by hand (it takes the promotion lock):

```bash
bin/refeather prune --dry-run   # list what would go
bin/refeather prune --keep 5
```

## Failure gates and retained evidence

Stop before promotion for an incomplete restore rehearsal, malformed state,
unreconciled transcript prefixes, active second writer, failed canary,
conflicting capabilities, or version mismatch. Retain source archive receipts,
release manifests, pre/post state hashes, the current/prior release targets,
Supervisor identity, journal JSONL, completed transaction state, and the exact
recovery command. Never include secret values in these receipts.

## Optional independent recovery chat

`recovery/server.mjs` is a standalone Node server using only builtins and the
three adjacent static assets. It does not import, call, start, or restart the
normal Feather backend. Nothing in staging, promotion, or normal server startup
enables it. It starts an OMP RPC child only after a human sends a request.

### Separate code, state, and service

Keep a reviewed copy of `recovery/` in an independently pinned, read-only tree
(for example `/opt/feather-recovery/pinned/recovery`). Do not point it at
`/opt/feather/current` or keep its only copy inside releases subject to normal
retention. Pin the Node runtime and OMP executable independently too, record
their versions and code hashes, and retain a prior working pin. Moving Feather's
release link must not move recovery. Deploying these files never requires an
`npm install` or frontend build.

Use a dedicated Unix service account with only the host permissions needed for
the repairs you intend to authorize. It is a real coding agent, not a sandbox:
its tools run with that account's permissions. Do not grant blanket sudo or
reuse a privileged account merely for convenience. Provision its OMP/provider
credentials explicitly; browser authentication does not provide model access.

Required environment:

| Variable | Meaning |
| --- | --- |
| `RECOVERY_ORIGIN` | Exact public HTTP(S) origin, including any nondefault port, with no trailing slash or path. Use HTTPS outside local smoke checks. |
| `RECOVERY_USER` | Exact authenticated `Remote-User` identity allowed to use this single-user service; there is no default account. |
| `RECOVERY_STATE_DIR` | Absolute private writable directory outside the code pin and normal Feather state. Run exactly one recovery service against it. |
| `RECOVERY_MODEL` | Explicit provider/model identifier supported by the pinned OMP installation. No provider or model is assumed. |
| `RECOVERY_THINKING` | Explicit thinking setting supported by that model and OMP version (for example `high`, where supported). |

Optional `RECOVERY_PORT` defaults to `4881` and always binds IPv4 loopback.
`RECOVERY_OMP_BIN` defaults to `omp` on PATH; use an absolute independently
pinned executable for production. `RECOVERY_CWD` defaults to `HOME`; set an
explicit existing workspace for production. Provide a private `HOME` and PATH
for the service account. Inherited `FEATHER_*`, `OMP_*`, `PI_*`, and `RECOVERY_*`
variables are removed from the agent environment to avoid inheriting another
session or backend integration. Configure any required OMP settings through
that account's local configuration instead; ordinary provider environment
variables remain available. Extensions, skills, rules, and automatic titles
are disabled for this child.

The optional `infra/feather-recovery.supervisor.conf` follows the existing
Supervisor convention but has `autostart=false`. Customize the account, paths,
workspace, log directory and permissions before loading it. Its required
`ENV_RECOVERY_*` substitutions must exist in the **supervisord daemon's**
environment, not merely the shell running `supervisorctl`. Installing the
template is not authorization to start it. An operator must explicitly load
and start the separate program; never change the normal Feather program to
point at recovery.

The state directory contains fsynced JSON request receipts in `turns/` and
durable native OMP session history in `sessions/`. The child uses that dedicated
session directory with `--continue`. Keep both together when backing up.
New directories/files use modes 0700/0600; pre-existing parent directories and
the service account's credentials still require an operator permission check.
There is no automatic retention or deletion. Transcripts and browser pending
requests can contain sensitive material; back them up and protect them as such.

### Authenticating proxy: ordering is a security boundary

The listener trusts only IPv4 loopback requests whose `Remote-User` equals
`RECOVERY_USER`. Every mutation additionally requires an exact `Origin` and
rejects a conflicting Fetch Metadata site. There is no wildcard CORS or
unauthenticated health exception. **Loopback is not authentication against
other local processes**: any process able to connect locally can forge that
header. Use only on a host where local users/processes are trusted.

For Caddy, put identity stripping, authentication, recovery routing, and the
ordinary fallback **inside one enclosing `route` block**. Caddy otherwise
reorders directives: merely placing `request_header` above `forward_auth` in
the file does not guarantee it runs first. Strip client-supplied identity
before authentication, then copy only the identity returned by the trusted
auth service. The example verify address/path must be adapted to your existing
auth gateway's successful verification endpoint and header contract:

```caddyfile
chat.example.test {
    route {
        request_header -Remote-User
        forward_auth 127.0.0.1:9091 {
            uri /verify
            copy_headers Remote-User
        }
        @recovery path /recovery /recovery/*
        handle @recovery {
            reverse_proxy 127.0.0.1:4881
        }
        handle {
            reverse_proxy 127.0.0.1:4870
        }
    }
}
```

Retain the `/recovery` prefix: use `handle`, **not** `handle_path`, and do not
strip or rewrite it upstream. Route it before the normal Feather catch-all;
`RECOVERY_ORIGIN` here would be `https://chat.example.test`. Integrate existing
login/static exceptions only after the outer identity strip and never allow
them to bypass authentication for `/recovery` or `/recovery/*`. Verify with an
unauthenticated forged `Remote-User` header that the public proxy refuses
access. A direct authenticated loopback request cannot prove proxy ordering.
Do not expose port 4881 on a public interface.

### Receipts, interruption, and protocol compatibility

The browser saves a UUID and exact prompt before sending; the server persists
acceptance before delivering the prompt to OMP. Retrying that same UUID/text
returns its saved receipt without sending again; different text with the same
UUID is rejected. There is one active request at a time. Reload/reconnect polls
saved output and never automatically replays a prompt. If browser storage is
unavailable, sending is disabled. An unconfirmed request requires an explicit
**Retry same request**, not a fresh duplicate.

On service restart, unfinished receipts become `interrupted` and are never
resent. This is durable acceptance and at-most-once prompt dispatch per retained
receipt, **not exactly-once tool execution**: a crash can occur before delivery,
or after side effects but before the receipt is updated. Inspect results before
requesting more work. Stop requests abort OMP and force-kill its process group
after eight seconds if necessary; stopping cannot undo completed actions.

OMP compatibility is intentionally explicit:

- The installed 18.1.10-style protocol completes a turn only on
  `agent_end` with `isTerminal: true` (or an acknowledged local command with
  `agentInvoked: false`). Unmarked/nonterminal `agent_end` events do not free
  the occupied request slot.
- Newer OMP advertises `isSettled` in `get_state`; recovery then uses correlated
  `prompt_result` and, when `sessionSettled: false`, waits for
  `session_settled`. An early local-command acknowledgement is not completion
  in this mode. Background wakes must settle before the next request.
- Native session paths must remain inside the dedicated recovery session
  directory. Protocol-v1 newline JSON frames are bounded to 1 MiB; malformed,
  oversized, or incomplete frames interrupt the turn rather than exposing raw
  agent diagnostics. Protocol-v2 chunk negotiation is not implemented. Pin and
  smoke-check your OMP version before upgrading; unsupported completion markers
  leave the slot occupied until Stop rather than guessing that it is idle.

The web view shows completed assistant text, not raw stderr, tool payloads,
provider metadata, or `get_state`. Its bounded display archive is separate from
the native session history. Plain text rendering avoids executing model output,
but it is not secret redaction: an authorized agent can still quote sensitive
information in its reply. Pending prompt text is also stored in same-origin
browser localStorage until acceptance is reconciled.

### Boundaries and operator smoke checks

This is backend independence, not disaster recovery isolation. It still shares
the host, disk, kernel, reverse proxy, authentication service, network, and
model/provider availability. It cannot repair a powered-off host, bypass a
failed authentication gateway, or produce answers when the provider is
unavailable. Same-origin malicious script in another application can access
recovery and its pending browser state; an isolated origin is stronger, if
your auth topology permits it. Retain SSH/console access and offline backups.

Graceful SIGTERM/SIGINT kills the child process group; uncatchable parent death
can leave a detached child or independently detached tool process alive.
Before starting another recovery instance after such a failure, use the OS
process tree and the dedicated session path to identify any survivor and have
an operator stop that exact process. Neither Supervisor group flags nor an
`interrupted` receipt proves all tool side effects have stopped.

Before opting in, use a disposable state directory, an unused loopback port,
an explicit local origin/user/model/thinking configuration, and a fake OMP
executable for offline protocol exercises. Do not use production credentials
or send a real diagnostic prompt as part of unattended checks:

1. Launch `node recovery/server.mjs` in the foreground (or a supervised
   throwaway process). GET `/recovery/api/state` with the configured
   `Remote-User` must return empty history without spawning OMP. Missing/wrong
   identity must return 403. GET `/recovery/`, `app.js`, and `style.css` should
   work without Feather running.
2. POST `/recovery/api/send` with JSON `{ "id": "<UUID-v4>", "text": "hello" }`.
   Missing/wrong Origin must return 403. The configured exact Origin and user
   must yield a durable 202 receipt; duplicate UUID/text returns that receipt,
   changed text with the same UUID returns 409, and a new UUID while occupied
   returns 409.
3. Have the fake OMP answer `get_state` with a session path under `sessions/`,
   acknowledge `prompt`, and emit a completed assistant message. Exercise both
   terminal `agent_end` and newer settled-protocol frames. Nonterminal
   `agent_end` and `prompt_result` with `sessionSettled: false` must keep the
   slot occupied; only the matching terminal/settled event completes it.
4. Exercise Stop, provider errors, malformed frames, service restart during an
   unfinished receipt, and retrieval of older/long replies. Restart must show
   interruption without another prompt dispatch. Reload the browser while a
   request is unconfirmed and confirm that only an explicit retry can send it.
5. Separately verify the actual public auth proxy rejects forged identity,
   preserves `/recovery`, and still serves recovery when only the main Feather
   backend is unavailable. Never stop production just to prove this; use a
   disposable proxy/backend configuration. Review the browser surface there.

After these offline checks, an operator may authorize a small read-only prompt
against the pinned real OMP/provider to establish version compatibility.
Do not auto-launch an agent, schedule a repair, replay saved prompts, or remove
history as part of installation or upgrade.
