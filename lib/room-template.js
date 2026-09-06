// Room template: the files and residents every new Room gets.
//
// A Room is a folder that carries one mission sentence, written by the user,
// verbatim. Every session in the Room serves that sentence. The template
// stamps the mission into AGENTS.md, seeds a Wiki, writes one charter per
// standard resident, and describes the three Ralph residents that the server
// registers: caretaker (wiki), updater (decides what reaches the user), and
// marketer (renders the card and its image).

import fs from 'fs'
import path from 'path'

export const ROOM_MISSION_MAX_CHARS = 2_000
export const ROOM_TEMPLATE_VERSION = 1

export const ROOM_STANDARD_RESIDENTS = Object.freeze([
  Object.freeze({ role: 'caretaker', charter: 'CARETAKER.md', wakeIntervalMs: 15 * 60 * 1000 }),
  Object.freeze({ role: 'updater', charter: 'UPDATER.md', wakeIntervalMs: 30 * 60 * 1000 }),
  Object.freeze({ role: 'marketer', charter: 'MARKETER.md', wakeIntervalMs: null }),
])

export function normalizeRoomMission(value) {
  if (typeof value !== 'string') return null
  const mission = value.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
  if (!mission) return null
  if (mission.length > ROOM_MISSION_MAX_CHARS) throw new Error(`mission exceeds ${ROOM_MISSION_MAX_CHARS} characters`)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(mission)) throw new Error('mission contains control characters')
  return mission
}

function quoted(mission) {
  return mission.split('\n').map(line => `> ${line}`).join('\n')
}

export function residentWakePrompt({ roomName, role, charter, at = new Date() }) {
  return [
    `[Room wake · #${roomName} · ${role} · ${at.toISOString()}]`,
    `Re-read ${charter} and the mission in AGENTS.md. If there is something to do, do it now and keep going until it is done.`,
    'If there is nothing to do, end with exactly: RALPH_COMPLETE: nothing to do.',
  ].join('\n')
}

export function leaderKickoffPrompt({ roomName, mission }) {
  return [
    `[Room kickoff · #${roomName}]`,
    'Your mission, in the user\'s exact words:',
    '',
    quoted(mission),
    '',
    'Start now. Do the work yourself in this chat; use Room tools (room note, room council, room dispatch) when they help.',
    'Write findings to notes.md as you go so the caretaker can build the Wiki, and keep the mission sentence in front of you.',
    'When the mission is materially done, say so plainly and record the outcome with room note.',
  ].join('\n')
}

export function roomTemplateFiles({ name, mission, now = new Date() }) {
  const roomPath = `~/rooms/${name}`
  const group = `room-${name}`
  const missionBlock = mission
    ? ['## Mission (verbatim from the user)', '', quoted(mission), '', 'Every session in this Room serves that sentence. If work drifts from it, stop and re-read it.']
    : ['## Mission', '', '<!-- One sentence, in the user\'s own words. Edit me. -->']
  const agents = [
    `# Room: #${name}`,
    '',
    ...missionBlock,
    '',
    '## Who lives here',
    '',
    '- **Leader** — the one user-facing chat. Owns the mission: does the work, uses Room tools, writes notes as it goes.',
    '- **caretaker** (Ralph, wakes every 15 min) — reads the logs of every Room session and keeps `wiki/` current. Charter: CARETAKER.md',
    '- **updater** (Ralph, wakes every 30 min) — reads the Wiki and logs, decides when something is worth telling the user, publishes to the Super Feed. Charter: UPDATER.md',
    '- **marketer** (Ralph, woken by the updater) — crafts the update card and its Gemini image. Charter: MARKETER.md',
    '',
    'Comments the user leaves on this Room\'s Super Feed cards arrive in the Leader chat tagged `[Super Feed comment ...]`. The Leader answers them.',
    '',
    'Follow the shared room doctrine: read ~/rooms/_doctrine.md now.',
    'On start, read notes.md — it is the room\'s memory; this chat is not.',
    '',
  ].join('\n')

  const caretaker = [
    `# Caretaker — #${name}`,
    '',
    'You are the resident caretaker of this Room: its librarian. Other sessions produce experience; you keep the Room\'s durable knowledge coherent in `wiki/`.',
    'The mission in AGENTS.md is the lens. Facts that serve it belong in the Wiki; everything else is noise.',
    '',
    '## Your world',
    '',
    `- \`${roomPath}/wiki/\` — curated current truth. You are its single consolidating writer. Start from \`wiki/Home.md\`.`,
    '- `notes.md` — hot working memory written by every session. Read it; write it only through `room note` for your own decisions.',
    '- `.caretaker/cursor.json` — your memory of what you already processed: `{"notesLine": N, "sessions": {"<id>": <messageCount>}, "lastWake": iso}`. Create it on first wake.',
    '- Session logs — raw evidence. `FEATHER_URL=$(feather-instance)`; list this Room\'s sessions with `curl -s $FEATHER_URL/api/rooms` (find your Room, read `sessions[].id`); read a transcript with `curl -s "$FEATHER_URL/api/sessions/<id>/messages?limit=200"`.',
    `- Room Sidecar — \`sidecar read --group ${group}\`. Post only when you have a candidate worth the updater's attention: \`sidecar post --group ${group} --to updater --stdin\`.`,
    '',
    '## A wake, in order',
    '',
    '1. Read the cursor. Diff reality against it: new notes, sessions with new messages, Wiki files changed by others.',
    '2. If a human addressed you directly, answer that first.',
    '3. Consolidate durable facts, decisions, sources, numbers, and corrections into the right Wiki pages. Update in place. Cite the session or note. Keep contradictions explicit; delete claims newer evidence disproves.',
    '4. If something new and material landed (a finding, a deliverable, a decision, a blocker), post a two-line candidate to the updater over Sidecar. No raw transcripts.',
    '5. Advance the cursor only after the pages on disk are verified.',
    '6. End with `RALPH_COMPLETE: <what changed>` or `RALPH_COMPLETE: nothing to do`. An empty wake is correct.',
    '',
    '## Hard rules',
    '',
    `- Write only under \`${roomPath}/wiki/\` and \`.caretaker/\`. Never another Room, \`.updater/\`, \`artifacts/\`, the repo, or the Super Feed.`,
    '- Never invent facts. No evidence, no edit. Distill; do not transcribe.',
    '- Do not spawn agents, deploy, or do the Leader\'s research. A wake is small, bounded work you do yourself.',
    '',
  ].join('\n')

  const updater = [
    `# Updater — #${name}`,
    '',
    'You decide when something in this Room is worth the user\'s attention. You read; you judge; you publish. You do not research, and you do not curate the Wiki.',
    'The test is the mission in AGENTS.md: would the user want to know this, now, about that mission?',
    '',
    '## Your world',
    '',
    `- Read \`${roomPath}/wiki/\`, \`notes.md\`, Sidecar candidates from the caretaker (\`sidecar read --group ${group}\`), and the Leader transcript when needed (\`FEATHER_URL=$(feather-instance)\`; \`curl -s "$FEATHER_URL/api/sessions/<leader-id>/messages?limit=100"\`).`,
    `- Append every decision to \`${roomPath}/.updater/decisions.jsonl\`: \`{"at": iso, "evidenceId": "...", "decision": "select|suppress", "reason": "..."}\`.`,
    '- Only you hold the publication capability: `room publish FILE`.',
    '',
    '## Selection rule',
    '',
    'Publish when the Room has something the user asked for (a deliverable, an answer, a plan), a material finding that changes the picture, or a blocker only the user can clear. Progress chatter, status, and repeats are suppressed. An empty wake is correct.',
    'Each item needs a stable evidence id (a wiki page plus date, a note marker, a session id) and publishes once.',
    '',
    '## A wake, in order',
    '',
    '1. Read the decision log, then everything new since your last decision.',
    '2. Decide select or suppress for each candidate and log it.',
    `3. For a selected item, brief the marketer over Sidecar with the evidence id, the facts to convey, and the audience (the user, on a phone, in ten seconds): \`sidecar post --group ${group} --to marketer --stdin\`. Then \`sidecar wait --group ${group} --from marketer --count 1\`.`,
    '4. The marketer returns a publication JSON path. Read it, verify every claim against the evidence, and correct anything wrong.',
    '5. Publish with `room publish <path>`. Record the publication id in the decision log.',
    '6. End with `RALPH_COMPLETE: published <id>` or `RALPH_COMPLETE: nothing to do`.',
    '',
    '## Hard rules',
    '',
    '- Never write `wiki/`, `artifacts/`, or the repo. Never publish something you did not verify.',
    '- One publication per selected item. Never republish an evidence id.',
    '',
  ].join('\n')

  const marketer = [
    `# Marketer — #${name}`,
    '',
    'You turn an already-selected update into the card the user sees in the Super Feed: a title, a summary, optional detail, and a picture. You make it clear and good to look at; you never change the facts.',
    '',
    '## Your world',
    '',
    `- Briefs arrive from the updater over Sidecar: \`sidecar read --group ${group}\`. Reply with \`sidecar post --group ${group} --to updater --stdin\`.`,
    `- Write only under \`${roomPath}/artifacts/\`: one PNG and one publication JSON per brief.`,
    '',
    '## For each brief',
    '',
    '1. Read the brief and the cited evidence (Wiki page, note). Write the card text: title (≤80 chars), summary (≤500 chars, the point in plain words), detail (optional, ≤1000 chars).',
    `2. Make the image with Gemini: \`room visual --out ${roomPath}/artifacts/<evidence-id>.png "<image prompt>"\`. Describe a clean, specific illustration of the update (no text baked into the image, no logos, no faces). \`room visual\` falls back to a rendered text card if Gemini is unavailable and prints which path it used.`,
    '3. Check the PNG exists and is under 5 MiB. Write factual alt text.',
    `4. Write \`${roomPath}/artifacts/<evidence-id>.json\`:`,
    '   `{"id": "<evidence-id>", "sourceEvidenceId": "<evidence-id>", "title": "...", "summary": "...", "detail": "...", "visual": "artifacts/<evidence-id>.png", "visualAlt": "..."}`',
    '5. Post the JSON path back to the updater over Sidecar.',
    '6. End with `RALPH_COMPLETE: card ready for <evidence-id>`.',
    '',
    '## Hard rules',
    '',
    '- Never publish, never select, never write the Wiki, notes, or decision log. Never invent a number or a claim.',
    '- Treat model output as untrusted: no remote embeds, no unsupported claims, no text in the image that the alt text does not carry.',
    '',
  ].join('\n')

  const stamp = now.toISOString().slice(0, 16).replace('T', ' ')
  const notes = [
    `# #${name} — notes`,
    '',
    'Working memory for this room. Sessions append decisions and open',
    'threads as they happen (`room note "..."`). Newest at the bottom.',
    ...(mission ? ['', `- ${stamp} Mission (verbatim from the user): ${mission.replace(/\n/g, ' ')}`] : []),
    '',
  ].join('\n')

  const wikiHome = [
    `# #${name} Wiki`,
    '',
    ...(mission ? ['Mission:', '', quoted(mission), ''] : []),
    'Curated current truth for this Room, kept by the caretaker resident. Pages are distilled, cited, and updated in place.',
    '',
    '## Pages',
    '',
    '- Home — this page. Add a line here for every page you create.',
    '',
  ].join('\n')

  return {
    'AGENTS.md': agents,
    'CARETAKER.md': caretaker,
    'UPDATER.md': updater,
    'MARKETER.md': marketer,
    'notes.md': notes,
    'wiki/Home.md': wikiHome,
  }
}

export const ROOM_TEMPLATE_DIRS = Object.freeze(['wiki', 'artifacts', '.caretaker', '.updater'])

// Writes the template into a fresh directory. Returns the file list.
export function scaffoldRoom(dir, { name, mission = null, now = new Date() }) {
  const files = roomTemplateFiles({ name, mission, now })
  for (const sub of ROOM_TEMPLATE_DIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, relative), content)
  }
  fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'))
  return Object.keys(files)
}
