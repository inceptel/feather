# Rooms v2 — rooms as conventions on existing primitives

Status: BUILDING — CLI + room folders shipped 2026-08-20; UI remaining
Date: 2026-08-20
Supersedes: the Buzz/Centaur multiplayer-room direction (2026-08-12). The
Buzz-backed Rooms tab was removed from main and archived on branch
`archive/buzz-rooms` (2026-08-20).

## The model

Rooms v1 failed because it made agents room *members* (multiplayer). The
correct model is 1 user, 1 chief per room, N disposable-or-resumable
workers — and it needs almost no new machinery:

1. **A room is a folder**: `~/rooms/<name>/` with
   - `AGENTS.md` — two-line room identity + "follow ~/rooms/_doctrine.md".
     `CLAUDE.md` is a symlink to it, so claude, codex, and omp chiefs all
     read the same priming (swapping brains = restarting the pinned chat
     with a different agent; no migration feature).
   - `notes.md` — the room's memory. Write-as-you-go; the chat is not the
     memory. Handoff/brain-swap/new-day are the same operation: distill to
     notes, start a fresh chat in the same cwd.
2. **The chief is a pinned Feather chat** whose cwd is the room folder.
   Child sessions group under the room by cwd — for free.
3. **`~/rooms/_doctrine.md`** — shared chief-of-staff doctrine (delegate,
   never grind, write as you go, verify mechanically). First line is a
   WORKER: guard so workers who ever see it defuse it.

## The `room` CLI (feather/bin/room)

Harness-neutral delegation floor — any brain that can run bash gets the
full doctrine. Claude chiefs may use native Agent/Workflow as a fast path.

- `room new <name>` / `room list`
- `room note "<text>"` — timestamped append to notes.md
- `room lookup "<q>"` — headless Haiku over transcripts + memory.jsonl
- `room council "<task>" [-n N]` — N sealed attempts, alternating
  claude/codex (`claude -p` / `codex exec`), then ONE judge (concurrent
  judges have produced garbage before). Journaled run dir; roll call names
  failures; empty output = FAILED, never "no findings".
- `room second-opinion "<q>"` — the non-brain harness, prompted skeptical
- `room spawn "<task>"` — real Feather session in the room cwd (visible,
  resumable), demoted by a WORKER: prefix
- `room handoff` — distiller appends a validated `## Handoff` section to
  notes.md (degrade-don't-clobber: refuses rather than writes garbage)

**Anti-recursion, two layers:** workers always run in
`~/.feather/room-runs/<room>/<run>/` — outside `~/rooms/`, so they never
inherit AGENTS.md (both harnesses walk ancestor dirs) — and every worker
prompt starts with WORKER:, which the doctrine's first line honors.

## UI (remaining work)

Default view = full-screen rooms home (iMessage model, phone-first): one
row per room from `~/rooms/*/` — title, latest (chief message or notes.md
tail), timestamp, status dot. Tap → existing session view; children listed
by cwd match. Sidebar untouched (Seats feedback stands). Server side:
folder-scan API only — no registry, no relay.

## Pilot

`#boat` (created 2026-08-20). One room for a week before the second.

## Out of scope

Centaur/k3s, multi-user identity, Buzz anything (relay + host quadlets
still to be cleaned up separately), sidebar changes, approval gating.
