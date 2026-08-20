# Rooms v2 — one chief per room, rooms as the front door

Status: DRAFT — awaiting Allan's sign-off
Date: 2026-08-20
Supersedes: the Buzz/Centaur multiplayer-room direction (2026-08-12) and the
current Buzz-backed Rooms tab (`frontend/src/components/Rooms.tsx`,
`server.js` rooms API around line 2390).

## Why the last attempt failed

Rooms v1 was multiplayer multi-agent: agents as room *members*. Wrong model.
The correct model:

- **1 user** (extra humans masquerade as the user, identified by convention
  in the message text — "Phil here —")
- **1 long-running super agent per room** (the chief of staff)
- **N arbitrary subagents**, each resumable if needed

Subagents are *tools the chief uses*, never members. No rosters, no personas,
no Seats (rejected 2026-08-09 — the sidebar session list stays untouched).

## Core concepts

### A room is a folder

`~/.feather/rooms/<room>/`:

- `room.json` — `{ id, title, brain: "claude"|"codex"|"omp", created }`
- `notes.md` — the chief's working memory: decisions, open threads, current
  state. **Write-as-you-go rule:** the chief records decisions and open
  threads here as they happen, not at handoff time.
- `wiki/` — reference pages (optional)
- `children.json` — index of spawned child sessions (id, task, status)

The room's identity lives in files, never in a session's context. The super
session is a disposable process reading the folder.

### The chief is a handoff, not an identity

Swapping brains (claude → codex), restarting after a crash, and a routine
"new day" restart are the SAME operation: distill live state into `notes.md`
(reuse the seat-handoff distiller: validation-gated rewrite,
degrade-don't-clobber), start a fresh session in the room cwd, it reads the
folder. Old transcripts stay searchable (`room lookup`) but working state
transfers only through the notes — same as a human chief-of-staff handoff.
Every restart rehearses the handoff, so lossy notes surface in days.

### Delegation doctrine (from the council work)

The chief delegates quickly and cross-harness — never just one subagent shape:

- **Quick lookups → Haiku.** "When did the user last mention X?" = headless
  Haiku over `~/.claude/projects/*/` transcripts + Feather session logs.
  Seconds, cheap.
- **Contested/important work → council.** 4 sealed independent attempts →
  ONE judge (judges run one at a time; concurrent judges silently returned
  all-zero rankings in the tournament runs). This is `arena` + `judge_panel`
  from the h5i patterns (reference: ~/h5i-owned/sdk-python/.../patterns.py).
- **Second opinions → the other harness.** Decorrelation is relative to the
  brain: Claude chief → `codex exec`; Codex chief → headless `claude -p` via
  Meridian (127.0.0.1:3456).
- **Long-lived work → a real Feather child session** (resumable, tagged with
  roomId, visible under the room). Throwaway work → in-process subagent.

Ops lessons that are LAW (paid for in the h5i/herdr era):
1. Verification is mechanical (tests, scripts, files-on-disk), never agent
   self-report.
2. Trust only ground truth for delivery — an output file, a submission —
   never a status field.
3. An empty result from a parallel step is a failure to investigate, not a
   "no findings".
4. No herdr, no TUI prompt injection anywhere: all delegation is headless
   (`claude -p`, `codex exec`, omp workers via ompcli).

### Harness-neutral `room` CLI

So any brain that can run bash gets the full doctrine (ompcos pattern,
generalized). Claude brains may use native Agent/Workflow tools as a fast
path; the CLI is the floor:

- `room lookup "<question>"` — Haiku transcript/notes search, prints answer
- `room council "<task>" [-n 4]` — sealed attempts + single judge; run dir
  under the room folder journals each step for resume
- `room spawn "<task>"` — create a roomId-tagged resumable Feather session,
  print its id
- `room second-opinion "<question|file>"` — routes to the non-brain harness
- `room note "<text>"` — append to notes.md (cheap write-as-you-go)
- `room handoff` — distill current session state into notes.md (distiller)

## UI

**Default view = full-screen Rooms home.** Not the sidebar. A chat-app home
screen (iMessage model), iPad/iPhone-first:

- One row/card per room: title, **latest** (last chief message snippet or
  last `notes.md` update), relative timestamp, chief status dot
  (running/idle/stale), unread indicator since last view.
- Tap room → the chief's session view (existing session UI, unchanged).
- Under the chief: the room's child sessions (from children.json + roomId
  tags), each tappable/resumable.
- "＋ New room" creates the folder + spawns the chief.
- The classic session list remains one tap away (tab/back) and is NOT
  modified — no rosters, no grouping changes (Seats feedback stands).

"Latest" source order: last assistant message in the chief transcript, else
last notes.md mtime + first line of its tail. Cached like the current
roomsCached() reads.

## Feather diff (kept small)

1. `server.js`: replace Buzz rooms API with folder-backed rooms API
   (list rooms + latest, create room, spawn/attach chief, list children by
   roomId tag). Reuse session-spawn + tagging mechanics (seat-sessions code
   archived 2026-08-09 is the reference).
2. `frontend`: Rooms.tsx → rooms home (default route); room detail =
   existing session view + children list.
3. `bin/room` CLI + symlink to ~/.local/bin.
4. `/room` skill: primes a chief with room notes + delegation doctrine +
   ops law. Registered as the chief's session priming on spawn/resume.
5. Retire Buzz-specific rooms code paths once #household is migrated or
   parked (Buzz retirement was already the standing plan).

## Pilot

Start with #boat (low stakes, real tasks: FB Marketplace watch via Mini
tunnel, todo list from Apple Notes). Second room only after a week of daily
use proves the chief + handoff loop.

## Out of scope

- Centaur/k3s (deferred; revisit only if isolation needs outgrow this)
- Multi-user identity, permissions, E2EE — one user, masquerading
- Any sidebar changes
- 👍 approval gating rebuild (rooms inherit the existing draft-only /
  Allan-taps-send conventions per capability)
