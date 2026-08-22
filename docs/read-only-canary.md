# Read-only canary contract

Set `FEATHER_READ_ONLY=1` to start Feather as an inspection-only server. This
is enforced by the backend; hiding controls in the SPA is optional presentation,
not the security boundary.

`GET /api/health` reports the active contract under `capabilities`:

```json
{
  "readOnly": true,
  "mutations": false,
  "terminal": false,
  "shell": false,
  "backgroundControllers": false
}
```

## Allowed HTTP surface

Static assets and non-API GET/HEAD requests remain readable. API GET/HEAD is
allowlisted to health, boxes, session lists/messages/streams/exports, Sidecar
lists/threads/streams, shared-session reads, sharing metadata without tokens,
projects, quick links, starred messages, file reads/listings, agents, and Rooms.

Every other API request receives HTTP 403 with:

```json
{ "error": "read-only canary", "code": "FEATHER_READ_ONLY" }
```

This includes all POST/DELETE mutations, unknown future GET endpoints, uploads,
transcription, session/tmux control, Room changes, Sidecar delivery and cleanup,
and editor launch. Authenticated shared-session reads do not append to the
sharing access log in this mode.

Terminal and shell WebSocket upgrades receive HTTP 403 before WebSocket or PTY
creation. The idle reaper is not scheduled, Sidecar garbage collection is
disabled, startup does not create/chmod state paths, and the `--add-peer` CLI
mutation refuses to run.

## Deployment containment

Application read-only mode is one canary gate, not an OS sandbox. A real canary
must also use copied `HOME` and `FEATHER_STATE_DIR` trees, a private `TMPDIR` and
`TMUX_TMPDIR`, loopback-only listening, read-only source mounts, and no production
home/state/tmux bind mounts. Before exposure, the migration preflight must reject
absolute symlinks, sockets, temporary paths, mounts, or writable realpaths that
escape those copied roots. The server's JSON-state layer separately rejects
recorded state files that resolve outside their configured state root.
